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

`index.html` の手動分析とは別に、`scripts/auto-check.mjs` が GitHub Actions で **24時間・30分おき** に
自動実行されます。

- **価格データの記録**: 24時間・毎回実行。BTC/USD と GOLD (XAU/USD) の最新価格(OHLC)を取得し、
  スプレッドシートに記録し続けます（直近40本だけでなく、過去分もずっと蓄積されます）
- **AI分析・Discord通知**: 日本時間 **9:00〜翌1:00のみ** 実行。取引しない1:00〜9:00の間は
  価格データの記録だけ行い、Claudeへの分析リクエストとDiscord通知はスキップします（コスト・通知の無駄を防ぐため）
- 「エントリーチャンスあり」と判定されたときだけ Discord に通知します（見送りのときは通知しません）
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

- **Claude API**: 分析(Haiku 4.5)は日本時間9:00〜翌1:00（16時間）のみ実行するため、
  おおよそ **月$7〜8（1,000円前後）**（変更なし）
- **GitHub Actions**: 24時間・30分おき（1日48回）に増えますが、1回あたり約15〜20秒のため
  月あたり合計10〜16分程度。無料枠（プライベートリポジトリで月2,000分）に十分収まります
- **Twelve Data / Discord / Google Sheets**: いずれも無料枠の範囲内

### 価格データ・分析結果をGoogle Sheetsに記録する（任意）

以下の2種類のデータをスプレッドシートに記録できます。Discord Webhookと同様、
Google Cloudの複雑な認証設定は不要です。

- **「価格データ」シート**: 24時間・毎回のチェックで、直近40本のうち**最新2本（直近30分ぶん）だけ**を記録します。
  40本すべてを毎回書き込むと前回と大きく重複してしまうため、この方式で少しずつ過去分を蓄積していきます
  （30分おきの実行を続けることで、直近40本という制限に関係なく過去分がずっと積み上がっていきます。1日あたり約190行）
- **「分析ログ」シート**: 日本時間9:00〜翌1:00の間、Claudeの判定結果（エントリー/見送り・方向・TP/SLなど）を記録
  （1日あたり約64行）

1. Google Sheetsで新しいスプレッドシートを作成する
2. メニューの「拡張機能」→「Apps Script」を開く
3. デフォルトのコードを全て削除し、以下を貼り付けて保存する

   ```javascript
   function doPost(e) {
     var data = JSON.parse(e.postData.contents);
     var ss = SpreadsheetApp.getActiveSpreadsheet();

     if (data.type === 'price') {
       var sheet = ss.getSheetByName('価格データ') || ss.insertSheet('価格データ');
       if (sheet.getLastRow() === 0) {
         sheet.appendRow(['日時', '銘柄', '始値', '高値', '安値', '終値']);
       }
       // 日時列はスプレッドシートが自動で「日付」型に変換してしまうと、
       // 下の重複チェック（文字列比較）が効かなくなるため、常に文字列として扱わせる。
       sheet.getRange('A:A').setNumberFormat('@');

       // 直近の実行と重複するローソク足をスキップ（同じ日時・銘柄の行が既にあれば追加しない）
       var checkRows = Math.min(sheet.getLastRow() - 1, 20);
       if (checkRows > 0) {
         var recent = sheet.getRange(sheet.getLastRow() - checkRows + 1, 1, checkRows, 2).getValues();
         var isDuplicate = recent.some(function (row) {
           return String(row[0]) === data.datetime && row[1] === data.symbol;
         });
         if (isDuplicate) {
           return ContentService.createTextOutput(JSON.stringify({ status: 'duplicate' }))
             .setMimeType(ContentService.MimeType.JSON);
         }
       }
       var newRow = sheet.getLastRow() + 1;
       sheet.getRange(newRow, 1, 1, 6).setValues([[data.datetime, data.symbol, data.open, data.high, data.low, data.close]]);
     } else {
       var logSheet = ss.getSheetByName('分析ログ') || ss.insertSheet('分析ログ');
       if (logSheet.getLastRow() === 0) {
         logSheet.appendRow(['日時', '銘柄', '直近終値', '判定', '方向', 'エントリー価格帯', 'TP', 'SL', '根拠/理由']);
       }
       logSheet.appendRow([
         data.timestamp || '',
         data.symbol || '',
         data.lastClose || '',
         data.verdict || '',
         data.direction || '',
         data.entryRange || '',
         data.tp || '',
         data.sl || '',
         data.reason || ''
       ]);
     }

     return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
       .setMimeType(ContentService.MimeType.JSON);
   }
   ```

4. 右上の「デプロイ」→「新しいデプロイ」を選択
5. 歯車アイコン（種類の選択）→「ウェブアプリ」を選ぶ
6. 「実行ユーザー」は **自分**、「アクセスできるユーザー」は **全員** を選択して「デプロイ」
7. 初回は権限承認を求められるので、自分のGoogleアカウントで許可する
8. 発行された「ウェブアプリのURL」（`https://script.google.com/macros/s/.../exec` の形式）をコピー
9. このリポジトリの Settings → Secrets and variables → Actions で
   `SHEETS_WEBHOOK_URL` という名前でこのURLを登録する

登録すると、次回の実行から自動的にスプレッドシートへの記録が始まります
（未設定のままでも他の機能には影響ありません）。既にこの機能を使っていて古いバージョンの
Apps Scriptコードを貼り付け済みの場合は、上記の新しいコードで置き換えて再デプロイしてください
（デプロイ済みのWebアプリURLは変わりません）。
