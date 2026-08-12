# チャート エントリー分析アプリ

チャートのスクリーンショットを貼り付けると、Claude (Anthropic API) が画像を解析し、

- **すでにエントリー済み**の場合 → 適切な **Take Profit / Stop Loss** を根拠付きで提案
- **まだエントリーしていない**場合 → エントリーすべきかどうか、すべきならどの価格帯で入るべきかを提案

してくれるシンプルな1枚のHTMLアプリです。サーバー不要、ブラウザだけで動作します。

## 使い方

1. `index.html` をブラウザで開く（ダブルクリックでOK。ローカルサーバーも不要）
2. 「APIキー」欄に [console.anthropic.com](https://console.anthropic.com/settings/keys) で発行した Anthropic APIキーを入力し「保存」
   - キーはブラウザの `localStorage` にのみ保存され、Anthropic 以外のどこにも送信されません
3. チャートのスクリーンショットを
   - クリックしてファイル選択
   - ドラッグ&ドロップ
   - 画面上で `Ctrl+V` / `Cmd+V` で貼り付け
   のいずれかで読み込む
4. 「未エントリー / エントリー済み」を選択し、必要な項目（方向・エントリー価格など）を入力
5. 「分析する」を押すと分析結果が表示される

## 注意事項

- APIキーはブラウザからAnthropic APIへ直接送信されます（`anthropic-dangerous-direct-browser-access` ヘッダーを使用）。個人利用のツールとして想定しており、共有PCや他人と共有するURLでは使わないでください。
- 出力内容は教育・参考目的の分析であり、投資助言ではありません。最終判断は自己責任で行ってください。
- 画像は分析前にブラウザ側で長辺 1568px 以内にリサイズされます。

## 自動監視（BTCUSD / GOLD）

`index.html` の手動分析とは別に、`scripts/auto-check.mjs` が GitHub Actions で30分おきに自動実行され、
BTC/USD と GOLD (XAU/USD) の直近の値動きをテキストデータで分析します。「エントリーチャンスあり」と
判定されたときだけ Discord に通知します（見送りのときは通知しません）。

- 実行時間帯: 日本時間 9:00〜翌1:00 のみ（1:00〜9:00は取引しないため実行自体をスキップ）
- 使用モデル: `claude-haiku-4-5`（コスト抑制のため。手動分析の `index.html` は精度重視で `claude-sonnet-5` を使用）
- 価格データ取得元: [Twelve Data](https://twelvedata.com/)（無料プランの範囲内で収まります）

### セットアップ（初回のみ）

このリポジトリの Settings → Secrets and variables → Actions で、以下の3つを登録してください。

| Secret名 | 内容 |
|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com/settings/keys) で発行したAPIキー |
| `TWELVEDATA_API_KEY` | [twelvedata.com](https://twelvedata.com/) で無料登録して取得するAPIキー |
| `DISCORD_WEBHOOK_URL` | 通知を受け取りたいDiscordチャンネルの Webhook URL（サーバー設定 → 連携サービス → Webhook → 新規作成） |

登録後は自動的にスケジュール実行されます。今すぐ動作確認したい場合は、GitHubの「Actions」タブ →
「Auto Market Check」→「Run workflow」で手動実行できます。

### コストの目安

30分おき・日本時間9:00〜翌1:00（16時間）稼働、BTCUSD/GOLDの2銘柄で、Claude API利用料は
おおよそ **月$7〜8（1,000円前後）** です（`claude-haiku-4-5` 使用時。価格データ取得・通知は無料）。
