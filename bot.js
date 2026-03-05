/**
 * 勤怠管理 Discord Bot
 *
 * 機能:
 * - /panel : 出勤・退勤ボタンパネルを表示
 * - /状態 : 今日の打刻状態を確認
 * - /修正 : 勤怠データを修正
 * - /集計 : 月次勤怠集計を表示
 * - ボタン操作で出勤・退勤をNotionに記録
 */

require('dotenv').config();
const {
  Client: DiscordClient,
  GatewayIntentBits,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  REST,
  Routes,
} = require('discord.js');
const { Client: NotionClient } = require('@notionhq/client');

// ── 設定 ─────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const TIMEZONE = process.env.TIMEZONE || 'Asia/Tokyo';

// ── クライアント初期化 ──────────────────────────────────
const discord = new DiscordClient({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const notion = new NotionClient({ auth: NOTION_API_KEY });

// ── ユーティリティ関数 ──────────────────────────────────

/** 日本時間の現在時刻を取得 */
function now() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
}

/** Date → YYYY-MM-DD */
function toDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Date → HH:MM */
function toTimeString(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${min}`;
}

/** HH:MM文字列 → 分数 */
function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

/** 勤務時間を計算（休憩1時間を控除、分数で返す） */
function calculateWorkMinutes(startTime, endTime) {
  const startMin = timeToMinutes(startTime);
  const endMin = timeToMinutes(endTime);
  return Math.max(0, endMin - startMin - 60);
}

/** 残業時間を計算（勤務時間 - 8時間、分数で返す） */
function calculateOvertimeMinutes(workMinutes) {
  return Math.max(0, workMinutes - 480);
}

/** 分数 → H:MM 形式の文字列 */
function minutesToHMM(minutes) {
  const h = Math.floor(minutes / 60);
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

// ── Notion操作 ──────────────────────────────────────────

/** 今日のユーザーレコードを検索 */
async function findTodayRecord(discordId) {
  const today = toDateString(now());

  const response = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      and: [
        {
          property: 'Discord ID',
          rich_text: { equals: discordId },
        },
        {
          property: '日付',
          date: { equals: today },
        },
      ],
    },
  });

  return response.results.length > 0 ? response.results[0] : null;
}

/** 出勤を記録 */
async function recordClockIn(discordId, displayName) {
  const currentTime = now();
  const timeStr = toTimeString(currentTime);
  const dateStr = toDateString(currentTime);

  const page = await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      '名前': {
        title: [{ text: { content: displayName } }],
      },
      '日付': {
        date: { start: dateStr },
      },
      'Discord ID': {
        rich_text: [{ text: { content: discordId } }],
      },
      '出勤時刻': {
        rich_text: [{ text: { content: timeStr } }],
      },
      'ステータス': {
        select: { name: '勤務中' },
      },
    },
  });

  return { pageId: page.id, time: timeStr, date: dateStr };
}

/** 退勤を記録 */
async function recordClockOut(pageId, startTime) {
  const currentTime = now();
  const endTimeStr = toTimeString(currentTime);
  const workMin = calculateWorkMinutes(startTime, endTimeStr);
  const overtimeMin = calculateOvertimeMinutes(workMin);

  await notion.pages.update({
    page_id: pageId,
    properties: {
      '退勤時刻': {
        rich_text: [{ text: { content: endTimeStr } }],
      },
      '勤務時間': {
        rich_text: [{ text: { content: minutesToHMM(workMin) } }],
      },
      '残業時間': {
        rich_text: [{ text: { content: minutesToHMM(overtimeMin) } }],
      },
      'ステータス': {
        select: { name: '退勤済' },
      },
    },
  });

  return { time: endTimeStr, workMin, overtimeMin };
}

/** 勤怠を修正 */
async function correctRecord(discordId, dateStr, startTime, endTime) {
  // 該当日のレコードを検索
  const response = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      and: [
        {
          property: 'Discord ID',
          rich_text: { equals: discordId },
        },
        {
          property: '日付',
          date: { equals: dateStr },
        },
      ],
    },
  });

  const workMin = calculateWorkMinutes(startTime, endTime);
  const overtimeMin = calculateOvertimeMinutes(workMin);

  if (response.results.length > 0) {
    // 既存レコードを更新
    const pageId = response.results[0].id;
    await notion.pages.update({
      page_id: pageId,
      properties: {
        '出勤時刻': {
          rich_text: [{ text: { content: startTime } }],
        },
        '退勤時刻': {
          rich_text: [{ text: { content: endTime } }],
        },
        '勤務時間': {
          rich_text: [{ text: { content: minutesToHMM(workMin) } }],
        },
        '残業時間': {
          rich_text: [{ text: { content: minutesToHMM(overtimeMin) } }],
        },
        'ステータス': {
          select: { name: '修正済' },
        },
      },
    });
    return { updated: true, workMin, overtimeMin };
  } else {
    return { updated: false };
  }
}

/** 月次集計を取得 */
async function getMonthlyStats(discordId, year, month) {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

  const response = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      and: [
        {
          property: 'Discord ID',
          rich_text: { equals: discordId },
        },
        {
          property: '日付',
          date: { on_or_after: startDate },
        },
        {
          property: '日付',
          date: { before: endDate },
        },
      ],
    },
    sorts: [{ property: '日付', direction: 'ascending' }],
  });

  const records = response.results;
  let totalWorkMin = 0;
  let totalOvertimeMin = 0;
  let workDays = 0;

  const details = records.map((record) => {
    const props = record.properties;
    const date = props['日付'].date?.start || '-';
    const start = props['出勤時刻'].rich_text?.[0]?.plain_text || '-';
    const end = props['退勤時刻'].rich_text?.[0]?.plain_text || '-';
    const workTime = props['勤務時間'].rich_text?.[0]?.plain_text || '-';
    const overtime = props['残業時間'].rich_text?.[0]?.plain_text || '0:00';
    const status = props['ステータス'].select?.name || '-';

    if (start !== '-' && end !== '-') {
      const wMin = calculateWorkMinutes(start, end);
      totalWorkMin += wMin;
      totalOvertimeMin += calculateOvertimeMinutes(wMin);
      workDays++;
    }

    return { date, start, end, workTime, overtime, status };
  });

  return { details, totalWorkMin, totalOvertimeMin, workDays };
}

// ── スラッシュコマンド登録 ───────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('勤怠打刻パネルを表示します'),

  new SlashCommandBuilder()
    .setName('状態')
    .setDescription('今日の打刻状態を確認します'),

  new SlashCommandBuilder()
    .setName('修正')
    .setDescription('勤怠データを修正します')
    .addStringOption((opt) =>
      opt.setName('日付').setDescription('修正する日付（YYYY-MM-DD）').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('出勤').setDescription('出勤時刻（HH:MM）').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('退勤').setDescription('退勤時刻（HH:MM）').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('集計')
    .setDescription('月次勤怠を集計します')
    .addIntegerOption((opt) =>
      opt.setName('年').setDescription('集計する年（省略時: 今年）').setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt.setName('月').setDescription('集計する月（省略時: 今月）').setRequired(false)
    ),
].map((cmd) => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    console.log('📝 スラッシュコマンドを登録中...');
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ スラッシュコマンド登録完了');
  } catch (error) {
    console.error('コマンド登録エラー:', error);
  }
}

// ── ボタンパネル作成 ─────────────────────────────────────

function createPanel() {
  const embed = new EmbedBuilder()
    .setTitle('🕐 勤怠管理')
    .setDescription('ボタンを押して出勤・退勤を記録してください。')
    .setColor(0x5865f2)
    .setFooter({ text: '打刻データはNotionに自動保存されます' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('clock_in')
      .setLabel('🟢 出勤')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('clock_out')
      .setLabel('🔴 退勤')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('correct')
      .setLabel('🟡 修正')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('reset_in')
      .setLabel('出勤取消')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('reset_out')
      .setLabel('退勤取消')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

// ── パネル管理 ───────────────────────────────────────────

/** パネルメッセージの参照を保持 */
let panelChannelId = null;
let panelMessageId = null;

/** パネルを再投稿して最下部に固定 */
async function refreshPanel(channel) {
  // 古いパネルを削除
  if (panelMessageId && panelChannelId === channel.id) {
    try {
      const oldMsg = await channel.messages.fetch(panelMessageId);
      await oldMsg.delete();
    } catch (_) { /* 既に削除済みなら無視 */ }
  }
  // 新しいパネルを投稿
  const msg = await channel.send(createPanel());
  panelChannelId = channel.id;
  panelMessageId = msg.id;
}

// ── イベントハンドラ ────────────────────────────────────

discord.once('ready', async () => {
  console.log(`✅ Bot起動完了: ${discord.user.tag}`);
  await registerCommands();
});

discord.on('interactionCreate', async (interaction) => {
  try {
    // ── ボタン操作 ──
    if (interaction.isButton()) {
      // 修正ボタンはモーダルを表示（deferReplyするとモーダルが出せないため先に処理）
      if (interaction.customId === 'correct') {
        const modal = new ModalBuilder()
          .setCustomId('correct_modal')
          .setTitle('勤怠修正');

        const dateInput = new TextInputBuilder()
          .setCustomId('correct_date')
          .setLabel('日付（YYYY-MM-DD）')
          .setValue(toDateString(now()))
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const startInput = new TextInputBuilder()
          .setCustomId('correct_start')
          .setLabel('出勤時刻（HH:MM）')
          .setValue('09:00')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const endInput = new TextInputBuilder()
          .setCustomId('correct_end')
          .setLabel('退勤時刻（HH:MM）')
          .setValue('18:00')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(dateInput),
          new ActionRowBuilder().addComponents(startInput),
          new ActionRowBuilder().addComponents(endInput)
        );

        await interaction.showModal(modal);
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const discordId = interaction.user.id;
      const displayName = interaction.member?.displayName || interaction.user.displayName;

      try {
        if (interaction.customId === 'clock_in') {
          const existing = await findTodayRecord(discordId);

          if (existing) {
            const status = existing.properties['ステータス'].select?.name;
            if (status === '勤務中') {
              await interaction.editReply({
                content: '⚠️ 既に出勤済みです。退勤ボタンを押してから再度出勤してください。',
              });
              return;
            }
            if (status === '退勤済' || status === '修正済') {
              await interaction.editReply({
                content: '⚠️ 本日は既に出勤・退勤が記録されています。修正が必要な場合は修正ボタンを使用してください。',
              });
              return;
            }
          }

          const result = await recordClockIn(discordId, displayName);
          const embed = new EmbedBuilder()
            .setTitle('✅ 出勤を記録しました')
            .setColor(0x57f287)
            .addFields(
              { name: '日付', value: result.date, inline: true },
              { name: '出勤時刻', value: result.time, inline: true }
            )
            .setFooter({ text: `${displayName}` })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });

        } else if (interaction.customId === 'clock_out') {
          const existing = await findTodayRecord(discordId);

          if (!existing) {
            await interaction.editReply({
              content: '⚠️ 本日の出勤記録がありません。先に出勤ボタンを押してください。',
            });
            return;
          }

          const status = existing.properties['ステータス'].select?.name;
          if (status === '退勤済' || status === '修正済') {
            await interaction.editReply({
              content: '⚠️ 本日は既に退勤済みです。修正が必要な場合は修正ボタンを使用してください。',
            });
            return;
          }

          const startTime = existing.properties['出勤時刻'].rich_text?.[0]?.plain_text;
          if (!startTime) {
            await interaction.editReply({
              content: '❌ 出勤時刻の取得に失敗しました。管理者に連絡してください。',
            });
            return;
          }

          const result = await recordClockOut(existing.id, startTime);
          const embed = new EmbedBuilder()
            .setTitle('✅ 退勤を記録しました')
            .setColor(0xed4245)
            .addFields(
              { name: '退勤時刻', value: result.time, inline: true },
              { name: '勤務時間', value: minutesToHMM(result.workMin), inline: true },
              { name: '残業時間', value: minutesToHMM(result.overtimeMin), inline: true }
            )
            .setFooter({ text: `${displayName}` })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });

        } else if (interaction.customId === 'reset_in') {
          // 出勤取消 → レコードごと削除
          const existing = await findTodayRecord(discordId);

          if (!existing) {
            await interaction.editReply({
              content: '⚠️ 本日の出勤記録がありません。',
            });
            return;
          }

          await notion.pages.update({
            page_id: existing.id,
            archived: true,
          });

          const embed = new EmbedBuilder()
            .setTitle('✅ 出勤を取り消しました')
            .setColor(0x95a5a6)
            .setDescription('本日の記録がリセットされました。再度出勤できます。')
            .setFooter({ text: `${displayName}` })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });

        } else if (interaction.customId === 'reset_out') {
          // 退勤取消 → 退勤時刻・勤務時間・残業時間をクリア、ステータスを勤務中に戻す
          const existing = await findTodayRecord(discordId);

          if (!existing) {
            await interaction.editReply({
              content: '⚠️ 本日の出勤記録がありません。',
            });
            return;
          }

          const status = existing.properties['ステータス'].select?.name;
          if (status === '勤務中') {
            await interaction.editReply({
              content: '⚠️ まだ退勤していません。',
            });
            return;
          }

          await notion.pages.update({
            page_id: existing.id,
            properties: {
              '退勤時刻': { rich_text: [] },
              '勤務時間': { rich_text: [] },
              '残業時間': { rich_text: [] },
              'ステータス': { select: { name: '勤務中' } },
            },
          });

          const embed = new EmbedBuilder()
            .setTitle('✅ 退勤を取り消しました')
            .setColor(0x95a5a6)
            .setDescription('退勤記録がリセットされました。再度退勤できます。')
            .setFooter({ text: `${displayName}` })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
        }
      } finally {
        // エラー時・正常時どちらでもパネルを最下部に再投稿
        await refreshPanel(interaction.channel).catch(() => {});
      }
    }

    // ── モーダル送信 ──
    if (interaction.isModalSubmit() && interaction.customId === 'correct_modal') {
      await interaction.deferReply({ ephemeral: true });

      const dateStr = interaction.fields.getTextInputValue('correct_date');
      const startTime = interaction.fields.getTextInputValue('correct_start');
      const endTime = interaction.fields.getTextInputValue('correct_end');

      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      const timeRegex = /^\d{2}:\d{2}$/;

      if (!dateRegex.test(dateStr)) {
        await interaction.editReply({ content: '❌ 日付の形式が正しくありません。YYYY-MM-DD で入力してください。' });
        return;
      }
      if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
        await interaction.editReply({ content: '❌ 時刻の形式が正しくありません。HH:MM で入力してください。' });
        return;
      }

      const result = await correctRecord(interaction.user.id, dateStr, startTime, endTime);

      if (result.updated) {
        const embed = new EmbedBuilder()
          .setTitle('✅ 勤怠を修正しました')
          .setColor(0xfee75c)
          .addFields(
            { name: '日付', value: dateStr, inline: true },
            { name: '出勤時刻', value: startTime, inline: true },
            { name: '退勤時刻', value: endTime, inline: true },
            { name: '勤務時間', value: minutesToHMM(result.workMin), inline: true },
            { name: '残業時間', value: minutesToHMM(result.overtimeMin), inline: true }
          );
        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.editReply({
          content: `❌ ${dateStr} の勤怠記録が見つかりませんでした。`,
        });
      }

      // モーダル送信後にパネルを最下部に再投稿
      await refreshPanel(interaction.channel);
    }

    // ── スラッシュコマンド ──
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'panel') {
        // 既存パネルがあれば削除
        if (panelMessageId && panelChannelId === interaction.channel.id) {
          try {
            const oldMsg = await interaction.channel.messages.fetch(panelMessageId);
            await oldMsg.delete();
          } catch (_) { /* 無視 */ }
        }
        const reply = await interaction.reply({ ...createPanel(), fetchReply: true });
        panelChannelId = interaction.channel.id;
        panelMessageId = reply.id;

      } else if (commandName === '状態') {
        await interaction.deferReply({ ephemeral: true });
        const record = await findTodayRecord(interaction.user.id);

        if (!record) {
          await interaction.editReply({ content: '📋 本日の打刻記録はまだありません。' });
          return;
        }

        const props = record.properties;
        const status = props['ステータス'].select?.name || '-';
        const start = props['出勤時刻'].rich_text?.[0]?.plain_text || '-';
        const end = props['退勤時刻'].rich_text?.[0]?.plain_text || '-';
        const workTime = props['勤務時間'].rich_text?.[0]?.plain_text;
        const overtime = props['残業時間'].rich_text?.[0]?.plain_text;

        const statusEmoji = status === '勤務中' ? '🟢' : status === '退勤済' ? '🔴' : '🟡';

        const embed = new EmbedBuilder()
          .setTitle(`📋 本日の勤怠状況`)
          .setColor(0x5865f2)
          .addFields(
            { name: 'ステータス', value: `${statusEmoji} ${status}`, inline: true },
            { name: '出勤時刻', value: start, inline: true },
            { name: '退勤時刻', value: end, inline: true }
          );

        if (workTime) {
          embed.addFields(
            { name: '勤務時間', value: workTime, inline: true },
            { name: '残業時間', value: overtime || '0:00', inline: true }
          );
        }

        await interaction.editReply({ embeds: [embed] });

      } else if (commandName === '修正') {
        await interaction.deferReply({ ephemeral: true });

        const dateStr = interaction.options.getString('日付');
        const startTime = interaction.options.getString('出勤');
        const endTime = interaction.options.getString('退勤');

        // バリデーション
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        const timeRegex = /^\d{2}:\d{2}$/;

        if (!dateRegex.test(dateStr)) {
          await interaction.editReply({ content: '❌ 日付の形式が正しくありません。YYYY-MM-DD で入力してください。' });
          return;
        }
        if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
          await interaction.editReply({ content: '❌ 時刻の形式が正しくありません。HH:MM で入力してください。' });
          return;
        }

        const result = await correctRecord(interaction.user.id, dateStr, startTime, endTime);

        if (result.updated) {
          const embed = new EmbedBuilder()
            .setTitle('✅ 勤怠を修正しました')
            .setColor(0xfee75c)
            .addFields(
              { name: '日付', value: dateStr, inline: true },
              { name: '出勤時刻', value: startTime, inline: true },
              { name: '退勤時刻', value: endTime, inline: true },
              { name: '勤務時間', value: minutesToHMM(result.workMin), inline: true },
              { name: '残業時間', value: minutesToHMM(result.overtimeMin), inline: true }
            );
          await interaction.editReply({ embeds: [embed] });
        } else {
          await interaction.editReply({
            content: `❌ ${dateStr} の勤怠記録が見つかりませんでした。`,
          });
        }

      } else if (commandName === '集計') {
        await interaction.deferReply({ ephemeral: true });

        const currentDate = now();
        const year = interaction.options.getInteger('年') || currentDate.getFullYear();
        const month = interaction.options.getInteger('月') || currentDate.getMonth() + 1;

        const stats = await getMonthlyStats(interaction.user.id, year, month);

        if (stats.workDays === 0) {
          await interaction.editReply({
            content: `📊 ${year}年${month}月の勤怠記録はありません。`,
          });
          return;
        }

        // 詳細テーブル
        let detailLines = stats.details.map((d) => {
          const dateShort = d.date.slice(5); // MM-DD
          const ot = d.overtime !== '0:00' ? ` (残業 ${d.overtime})` : '';
          return `\`${dateShort}\` ${d.start} - ${d.end}  **${d.workTime}**${ot}  ${d.status === '修正済' ? '(修正)' : ''}`;
        });

        const embed = new EmbedBuilder()
          .setTitle(`📊 ${year}年${month}月 勤怠集計`)
          .setColor(0x5865f2)
          .setDescription(detailLines.join('\n'))
          .addFields(
            { name: '出勤日数', value: `${stats.workDays}日`, inline: true },
            { name: '総勤務時間', value: minutesToHMM(stats.totalWorkMin), inline: true },
            { name: '総残業時間', value: minutesToHMM(stats.totalOvertimeMin), inline: true }
          )
          .setFooter({ text: `${interaction.user.displayName} の集計` });

        await interaction.editReply({ embeds: [embed] });
      }
    }
  } catch (error) {
    console.error('エラー:', error);

    const replyMethod = interaction.deferred || interaction.replied
      ? 'editReply'
      : 'reply';

    await interaction[replyMethod]({
      content: '❌ エラーが発生しました。しばらくしてからもう一度お試しください。',
      ephemeral: true,
    }).catch(() => {});
  }
});

// ── パネル自動再投稿（他のメッセージでパネルが流れた場合） ──
discord.on('messageCreate', async (message) => {
  // Bot自身のメッセージ、またはパネルが無いチャンネルは無視
  if (message.author.bot) return;
  if (message.channel.id !== panelChannelId) return;

  await refreshPanel(message.channel).catch(() => {});
});

// ── Bot起動 ─────────────────────────────────────────────
discord.login(DISCORD_TOKEN);
