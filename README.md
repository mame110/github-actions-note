# Note Workflow – GitHub Actions

このリポジトリの `.github/workflows/note.yaml` は、以下のパイプラインをGitHub Actionsで実行します。

1) **リサーチAgent**: Claude Code SDK の WebSearch / WebFetch によるリサーチレポート作成
2) **執筆Agent**: Anthropic Claude 4.0 Sonnet でタイトル/本文/タグ(JSON)を生成
3) **ファクトチェックAgent**: Tavily を使った検証結果を反映し本文を修正
4) **ドラフトAgent**: Playwrightで note.com に下書き/公開（storageState を利用）

---

## 事前準備（リポジトリSecrets）

以下の環境変数をGitHub Actionsのリポジトリシークレットに設定してください：

- `ANTHROPIC_API_KEY`（必須）- Claude APIキー
- `TAVILY_API_KEY`（必須）- Tavily検索APIキー
- `NOTE_STATE_B64`（必須）- Base64文字列化した note.com のログイン状態（後述の手順で取得）

---

## 実行方法

GitHub Actions > Note Workflow を手動実行し、以下の入力を与えます：

- **theme**: 記事テーマ（必須）
- **target**: 想定読者（必須）
- **message**: 伝えたい核メッセージ（必須）
- **cta**: 読後のアクション（必須）
- **tags**: カンマ区切りタグ（任意）
- **is_public**: true/false（公開 or 下書き保存）
- **dry_run**: true/false（投稿スキップ）

---

## note-state.json の取得手順（Playwright storageState）

note.com へのログイン情報は Playwright の storageState(JSON) を用います。以下の手順で取得してください。

### 1. ローカルで Playwright を準備

```bash
npm init -y
npm install playwright
npx playwright install chromium
```

### 2. 手動ログインスクリプトの作成と実行

まず、以下の内容で `login-note.mjs` を作成してください：

```javascript
import { chromium } from 'playwright';
import fs from 'fs';

const STATE_PATH = './note-state.json';

// 手動ログインのため環境変数は不要

const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://note.com/login');

  console.log('手動でログインしてください。ログイン完了を自動検知します...');
  
  // ログイン完了を自動検知（note.comのトップページに遷移するまで待機）
  try {
    await page.waitForURL(/note\.com\/?$/, { timeout: 300000 }); // 5分待機
    console.log('ログイン完了を検知しました！');
  } catch (error) {
    console.log('ログイン完了の検知に失敗しました。手動でEnterキーを押してください。');
    await new Promise(resolve => {
      process.stdin.once('data', () => {
        resolve();
      });
    });
  }

  console.log('ログイン状態を保存中...');

  // 保存
  await context.storageState({ path: STATE_PATH });
  console.log('Saved:', STATE_PATH);

  await browser.close();
})();
```

そして、スクリプトを実行します：

```bash
node login-note.mjs
```

### 3. 手動ログイン手順

1. スクリプトを実行すると、ブラウザが自動で起動し note.com のログインページが開きます
2. **手動で**ログインを完了してください（メール、Google、Twitter等、お好みの方法で）
3. ログインが完了すると、スクリプトが自動でログイン状態を検知します（最大5分待機）
4. 検知に失敗した場合は、ターミナルでEnterキーを押してください
5. カレントディレクトリに `note-state.json` が生成されます

### 4. Secret に保存

1. 生成された `note-state.json` をBase64文字列に変換します
   - macOS/Linux: `base64 -w 0 note-state.json`
   - Windows (PowerShell): `[Convert]::ToBase64String([IO.File]::ReadAllBytes('note-state.json'))`
2. GitHub リポジトリ Settings > Secrets and variables > Actions > New repository secret
3. Name: `NOTE_STATE_B64`
4. Secret: 1 で得たBase64文字列を貼り付け

---

## 動作イメージ

1. **Research ジョブ**: Claude Code SDK を使用してWebSearchとWebFetchでリサーチを実行
2. **Write ジョブ**: Claude Sonnet 4.0 でタイトル、本文、タグを生成
3. **Fact-check ジョブ**: Tavily API で事実確認を行い、本文を修正
4. **Post ジョブ**: Playwright でnote.comに自動投稿
   - `is_public: false` の場合は「下書き保存」
   - `is_public: true` の場合は「公開」
   - `dry_run: true` の場合は投稿をスキップ

ワークフロー実行時に `NOTE_STATE_B64` をデコードして一時ファイルに展開し、Playwright の storageState として使用します。JSONとして壊れている場合は展開時に検知して処理が停止します。

---

## 注意事項

- **storageStateの期限**: storageState は期限切れ・無効化されることがあります。ログイン情報が切れた場合は、同手順で再取得してください
- **UI変更への対応**: note.com 側のUI変更でセレクタが変わる場合があります。その際は `post.mjs` 内のセレクタ調整が必要です
- **AI生成コンテンツ**: 生成AIの出力は誤情報を含む場合があります。公開前に最終レビューをおすすめします
- **手動ログイン**: セキュリティ上の理由から、パスワードを環境変数に保存せず、手動ログイン方式を採用しています
- **機密情報の管理**: `login-note.mjs` と `note-state.json` は `.gitignore` に追加されており、Gitリポジトリには含まれません

---

## 技術スタック

- **GitHub Actions**: CI/CDパイプライン
- **Claude Code SDK**: リサーチAgent（WebSearch/WebFetch）
- **AI SDK (Anthropic)**: 執筆・ファクトチェックAgent
- **Tavily API**: 事実確認・検証
- **Playwright**: note.com への自動投稿
- **marked**: Markdown to HTML変換

---

## ファイル拡張子について

- **`.mjs`ファイル**: ES Modules（`import`/`export`）を使用するJavaScriptファイルです
- **package.jsonの設定**: `"type": "module"` がない場合でも、`.mjs` 拡張子でES Modulesが使用できます
- **従来の`.js`**: CommonJS（`require`/`module.exports`）方式です

---

## 参考

- [Claude Code SDK](https://github.com/anthropics/anthropic-claude-code)
- [AI SDK (Anthropic)](https://sdk.vercel.ai/docs)
- [Tavily API](https://docs.tavily.com/)
- [Playwright](https://playwright.dev/)
