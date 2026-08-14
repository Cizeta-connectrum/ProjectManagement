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

`index.html` の手動分析とは別に、`scripts/auto-check.mjs` が GitHub Actionsで自動実行され、
監視の密度に濃淡をつけています。

> **注意**: GitHub Actionsのスケジュール実行（cron）は、指定した時刻通りに発火する保証がありません。
> 負荷状況によっては数十分〜1時間以上ずれることがあります。通常監視（下記）はこれを見越して
> 「壁時計の分」ではなく「前回の本チェックからの経過時間（25分以上）」で判定しており、実際の発火が
> どれだけずれても価格データの記録や分析が取りこぼされないようにしています。集中監視（下記）は
> このcronの不安定さの影響を受けないよう、GitHub側の発火を待たずスクリプト自身がループする設計に
> しています。

- **ポジション未保有の銘柄（通常監視）**: 前回の本チェックから25分以上経過している実行でのみ動作します。
  - 価格データの記録は24時間・毎回実行（BTC/USD と GOLD (XAU/USD) の最新価格(OHLC)をスプレッドシートに記録し続け、
    直近40本という制限に関係なく過去分がずっと蓄積されます）
  - Claude分析・Discord通知は日本時間 **9:00〜翌1:00のみ** 実行（取引しない1:00〜9:00はスキップし、コスト・通知の無駄を防ぎます）
  - 「エントリーチャンスあり」と判定されたときだけ Discord に通知し（見送りのときは通知しません）、そのままそのポジションの追跡を開始します
  - 経過時間が25分未満の実行は何もせず即終了します
- **ポジション保有中の銘柄（集中監視）**: エントリーが発生すると、そのジョブ自身が**プロセス内で5分おきに
  ループ**し、Claudeへ「保有継続 / TP到達 / SL到達 / 撤退推奨」を判断させ続けます（GitHub Actionsの
  スケジュール発火を待たないため、正確に5分間隔になります）。ループ中も、ポジションを持っていない
  もう一方の銘柄の通常監視（25分以上経過チェック）は引き続き行われます。TP到達・SL到達・撤退推奨の
  いずれかになったらDiscordに通知して追跡を終了し、ジョブも終了して通常監視に戻ります。万一ポジションが
  長時間（5時間）解決しない場合は、いったんジョブを終了し、次にGitHub側のスケジュールが発火したタイミングで
  監視を再開します
- 使用モデル: `claude-haiku-4-5`（コスト抑制のため。手動分析の `index.html` は精度重視で `claude-sonnet-5` を使用）
- 価格データ取得元: [Twelve Data](https://twelvedata.com/)（無料プランの範囲内で収まります）
- 実行状態は `data/open-positions.json`（保有中ポジション）と `data/state.json`（前回の本チェック時刻）に
  JSONで保存されます。GitHub Actionsの実行環境は毎回使い捨てのため、状態が変わるたびにスクリプト自身が
  その場でリポジトリにコミット・プッシュします（集中監視ループが数時間続くこともあるため、最後にまとめてで
  はなく都度コミットすることで、途中でジョブが落ちても進捗を失わないようにしています）

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

- **Claude API**: 通常監視分は日本時間9:00〜翌1:00（16時間）のみ実行するため、
  おおよそ **月$7〜8（1,000円前後）**。ポジション保有中の集中監視（5分おき）が追加分のコストになりますが、
  保有時間が数十分〜数時間程度であればごく少額（数百円以内）の増加に収まる見込みです
- **GitHub Actions**: ポジション未保有時はほぼ即終了するため負荷は小さいですが、**ポジション保有中はジョブが
  解決するまで実行され続ける**ため、保有時間 ＝ 消費するActions時間になります（例: 1エントリーの保有時間が
  1時間なら約60分消費）。エントリー頻度・保有時間によっては無料枠（プライベートリポジトリで月2,000分）を
  超える可能性があり、その場合は少額の追加課金（$0.008/分）が発生します。エントリーが多い/保有が長い運用に
  なってきたら、実際の消費時間をGitHubの「Settings → Billing」で確認してください
- **Twelve Data / Discord / Google Sheets**: いずれも無料枠の範囲内

### 価格データ・分析結果をGoogle Sheetsに記録する（任意）

以下の2種類のデータをスプレッドシートに記録できます。Discord Webhookと同様、
Google Cloudの複雑な認証設定は不要です。

- **「価格データ」シート**: 30分おきのチェックで、直近40本のうち**最新2本（直近30分ぶん）だけ**を記録します。
  40本すべてを毎回書き込むと前回と大きく重複してしまうため、この方式で少しずつ過去分を蓄積していきます
  （30分おきの実行を続けることで、直近40本という制限に関係なく過去分がずっと積み上がっていきます。1日あたり約190行）
- **「分析ログ」シート**: 日本時間9:00〜翌1:00の間、Claudeの判定結果（エントリー/見送り・方向・おすすめ度・TP/SLなど）を記録
  （1日あたり約64行）。エントリー判定のときは、セットアップの良さをClaudeが5段階（1〜5）で自己評価した
  「おすすめ度」も記録されます
- **「ポジション追跡ログ」シート**: エントリー判定が出たポジションについて、解決するまで5分おきの状況判断
  （保有継続/TP到達/SL到達/撤退推奨とそのコメント）を記録します（行数はポジション保有時間に応じて変動します）
- **「勝率」シート**: 「ポジション追跡ログ」の集計から、銘柄別のTP到達/SL到達/撤退推奨件数と勝率（TP到達÷
  (TP到達+SL到達)）を自動計算する数式が入ります。エントリー通知・ポジション解決通知にも、その時点の勝率が
  自動的に添えられます

1. Google Sheetsで新しいスプレッドシートを作成する
2. メニューの「拡張機能」→「Apps Script」を開く
3. デフォルトのコードを全て削除し、以下を貼り付けて保存する

   ```javascript
   function ensureWinRateSheet(ss) {
     if (ss.getSheetByName('勝率')) return;
     var sheet = ss.insertSheet('勝率');
     sheet.appendRow(['銘柄', 'TP到達', 'SL到達', '撤退推奨', '勝率']);
     var symbols = ['BTC/USD', 'GOLD (XAU/USD)'];
     symbols.forEach(function (symbol, i) {
       var row = i + 2;
       sheet.getRange(row, 1).setValue(symbol);
       sheet.getRange(row, 2).setFormula('=COUNTIFS(ポジション追跡ログ!B:B,A' + row + ',ポジション追跡ログ!D:D,"TP到達")');
       sheet.getRange(row, 3).setFormula('=COUNTIFS(ポジション追跡ログ!B:B,A' + row + ',ポジション追跡ログ!D:D,"SL到達")');
       sheet.getRange(row, 4).setFormula('=COUNTIFS(ポジション追跡ログ!B:B,A' + row + ',ポジション追跡ログ!D:D,"撤退推奨")');
       sheet.getRange(row, 5).setFormula('=IF((B' + row + '+C' + row + ')=0,"-",TEXT(B' + row + '/(B' + row + '+C' + row + '),"0%"))');
     });
   }

   // Discordへの通知に載せる勝率をNode側から取得するためのGETエンドポイント。
   // 例: <ウェブアプリURL>?symbol=BTC/USD
   function doGet(e) {
     var symbol = e.parameter.symbol;
     var ss = SpreadsheetApp.getActiveSpreadsheet();
     var sheet = ss.getSheetByName('ポジション追跡ログ');
     var result = { tp: 0, sl: 0, bail: 0 };
     if (sheet && symbol) {
       var data = sheet.getDataRange().getValues();
       for (var i = 1; i < data.length; i++) {
         if (data[i][1] === symbol) {
           if (data[i][3] === 'TP到達') result.tp++;
           else if (data[i][3] === 'SL到達') result.sl++;
           else if (data[i][3] === '撤退推奨') result.bail++;
         }
       }
     }
     return ContentService.createTextOutput(JSON.stringify(result))
       .setMimeType(ContentService.MimeType.JSON);
   }

   function doPost(e) {
     var data = JSON.parse(e.postData.contents);
     var ss = SpreadsheetApp.getActiveSpreadsheet();
     ensureWinRateSheet(ss);

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
     } else if (data.type === 'position_check') {
       var posSheet = ss.getSheetByName('ポジション追跡ログ') || ss.insertSheet('ポジション追跡ログ');
       if (posSheet.getLastRow() === 0) {
         posSheet.appendRow(['日時', '銘柄', '現在値', '判定', 'コメント']);
       }
       posSheet.appendRow([
         data.timestamp || '',
         data.symbol || '',
         data.lastClose || '',
         data.verdict || '',
         data.comment || ''
       ]);
     } else {
       var logSheet = ss.getSheetByName('分析ログ') || ss.insertSheet('分析ログ');
       if (logSheet.getLastRow() === 0) {
         logSheet.appendRow(['日時', '銘柄', '直近終値', '判定', '方向', 'おすすめ度', 'エントリー価格帯', 'TP', 'SL', '根拠/理由']);
       }
       logSheet.appendRow([
         data.timestamp || '',
         data.symbol || '',
         data.lastClose || '',
         data.verdict || '',
         data.direction || '',
         data.confidence || '',
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
10. あわせて、スプレッドシート自体のURL（ブラウザのアドレスバーに表示されている
    `https://docs.google.com/spreadsheets/d/.../edit` の形式）をコピーし、
    `SPREADSHEET_URL` という名前で登録する（任意）。登録すると、Discordのエントリー通知・
    ポジション解決通知に毎回スプレッドシートへのリンクが添えられ、確認しに行きやすくなります

登録すると、次回の実行から自動的にスプレッドシートへの記録が始まります
（未設定のままでも他の機能には影響ありません）。既にこの機能を使っていて古いバージョンの
Apps Scriptコードを貼り付け済みの場合は、上記の新しいコードで置き換えて再デプロイしてください
（デプロイ済みのWebアプリURLは変わりません）。
