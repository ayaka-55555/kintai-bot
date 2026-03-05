# 勤怠Bot を 24時間稼働させる（スマホ・他メンバーからも利用可能）

PC を起動していないときも Discord から勤怠入力できるようにするには、**Bot をクラウドで常時稼働**させます。

## 方法1: Railway でデプロイ（おすすめ）

[Railway](https://railway.app/) の無料枠で Node アプリを常時稼働できます。

### 手順

1. **GitHub にリポジトリを作成**
   - このフォルダを Git で管理し、GitHub にプッシュ（`.env` は含めない）

2. **Railway に登録**
   - https://railway.app/ で GitHub アカウントでログイン

3. **新規プロジェクト**
   - "New Project" → "Deploy from GitHub repo" でリポジトリを選択

4. **環境変数を設定**
   - プロジェクト → 対象サービス → "Variables" で以下を追加：
   - `DISCORD_TOKEN`
   - `DISCORD_CLIENT_ID`
   - `DISCORD_GUILD_ID`
   - `NOTION_API_KEY`
   - `NOTION_DATABASE_ID`
   - `TIMEZONE`（任意・例: `Asia/Tokyo`）

5. **起動コマンド**
   - "Settings" → "Deploy" で "Start Command" を `node bot.js` または `npm start` に設定（未設定の場合は自動検出されます）

6. **デプロイ**
   - 保存すると自動でビルド・起動。ログで「Bot起動完了」が出ていればOKです。

これで PC を消していても、スマホの Discord アプリや他のメンバーからも `/panel` や出勤・退勤ボタンが利用できます。

---

## 方法2: Render でデプロイ

[Render](https://render.com/) の無料枠でも常時稼働可能です（スリープする場合あり）。

1. https://render.com/ で GitHub と連携
2. "New" → "Web Service" でリポジトリを選択
3. 環境変数に上記と同じキーを設定
4. "Build Command": `npm install`
5. "Start Command": `node bot.js`
6. デプロイ

無料プランでは一定時間アクセスがないとスリープする場合があります。常時オンにしたい場合は有料プランか Railway を検討してください。

---

## 注意事項

- **`.env` は絶対に GitHub に上げない**（環境変数は Railway/Render の画面でだけ設定）
- Notion のデータベースは、Bot と同じ Notion 連携で共有している限り、誰が打刻しても同じ DB に記録されます
- サーバー内のメンバーは全員、各自の Discord アカウントで出勤・退勤でき、Notion には「名前」「Discord ID」で区別されて記録されます
