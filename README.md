# 都営バス運用情報

Next.js / TypeScript で作成した都営バス向けの運用情報サイトです。系統・停留所をGTFS-JPから生成し、GTFS-Realtime VehiclePositionをサーバー側で解析して表示します。実データを取得できない場合は、架空の系統・車両を表示しません。

## セットアップ

1. Node.js 20.9以上とnpmを用意します（確認環境ではNode.js 26.13.0 / npm 11.20.0でビルド済み）。
2. ODPT開発者サイトでアカウント登録し、利用条件に同意してAPIキーを取得します。登録完了まで最大2営業日かかる場合があります: [開発者サイト](https://developer.odpt.org/)、[登録ページ](https://developer.odpt.org/signup)
3. ODPTのデータカタログで、[都営バス GTFS-JP](https://ckan.odpt.org/dataset/b_bus_gtfs_jp-toei) と[GTFS-RT VehiclePosition](https://ckan.odpt.org/dataset/b_bus_gtfs_rt-toei) のリソースを開き、APIエンドポイントURLを確認します。URLを推測して設定しないでください。
4. このディレクトリで `Copy-Item .env.example .env.local` を実行し、`.env.local` をテキストエディターで開いて、APIキーとカタログのURLを入力します。

```dotenv
ODPT_API_KEY=ODPTで発行されたAPIキー
ODPT_GTFS_STATIC_URL=カタログのGTFS-JPリソースURL
ODPT_VEHICLE_POSITIONS_URL=カタログのVehiclePositionリソースURL
```

サーバー側でODPTの `acl:consumerKey` クエリパラメーターを付けて接続します。カタログURLに空の `acl:consumerKey=` が含まれている場合もキーを設定して使います。`.env.local` は共有・送信せず、APIキーをチャットや公開リポジトリに貼らないでください。環境変数名に `NEXT_PUBLIC_` を付けないでください。

PowerShellで `.env.local` を作る例:

```powershell
Copy-Item .env.example .env.local
notepad .env.local
```

入力して保存したら、起動中のサーバーを `Ctrl+C` で止めて再起動します。

Windows PowerShellでは、実行ポリシーによって `npm.ps1` がブロックされる場合があるため、`.cmd` を指定します。

```powershell
npm.cmd install
npm.cmd run dev
```

ブラウザで `http://localhost:3000` を開きます。本番用ビルドは `npm.cmd run build`、起動は `npm.cmd run start` です。

TypeScriptの静的チェックは `npm.cmd run typecheck` で実行できます。

## 実装状況

- 系統検索・一覧と方向別停留所図をGTFS-JPから生成（GTFSのdirection_idを方向として表示）
- VehiclePositionを15秒間隔でサーバー側取得し、Next.jsのデータキャッシュとメモリキャッシュで配信
- GTFS-JPは6時間間隔で再取得し、ブラウザーも系統情報を15秒ごとに取り直さない
- 車両IDを英字・数字の自然順で表示し、GTFS trip_idから行き先停留所を対応付け
- 車両詳細、位置・速度・方位・便ID・データ取得時刻を表示
- 未設定、取得エラー、最後の取得時刻、古いデータの表示に対応
- モバイル表示対応、ODPT出典と正確性に関する注記

## 制限・今後の作業

- この環境ではODPT APIキーおよびデータカタログのアカウント固有URLが与えられていないため、実API接続は未確認です。
- 接続層はGTFS-Realtime Protocol BuffersのVehiclePositionフィードを想定します。実際のエンドポイントと利用可能なリソースはODPTアカウントのデータカタログで確認してください。
- 方向別停留所列は各direction_idの代表便から作ります。上り/下りという方向名称が提供されない場合はGTFSの方向IDを表示します。
- TripUpdate、ServiceAlert、到着予測、車両位置の路線投影は未実装です。次の便・仮運番予測は、下記の履歴収集を設定した場合のみ利用できます。Current Stop Sequenceだけから現在停留所を表示するため、提供事業者のstop_sequenceとGTFS便データが一致しないケースでは不正確になりえます。
- 稼働環境が複数プロセスの場合、キャッシュはプロセス間共有ではありません。共有キャッシュ基盤が必要になった際に差し替えてください。

## Vercelへの公開

1. GitHubで個人アカウントのリポジトリを作成し、このプロジェクトのソースをアップロードします。`node_modules`、`.next`、`.npm-cache`、`.env.local` はアップロードしないでください。
2. Vercelで「Add New Project」からGitHubリポジトリをImportします。Next.jsを自動検出するため、通常はビルド設定を変更する必要はありません。
3. Project SettingsのEnvironment Variablesに `ODPT_API_KEY`、`ODPT_GTFS_STATIC_URL`、`ODPT_VEHICLE_POSITIONS_URL` を設定します。APIキーをGitHub側へ追加しないでください。
4. Deployを選択します。Hobbyプランは個人・非商用用途に限られるため、用途が変わる場合はプラン条件を確認してください。

## 出典・利用条件

データ出典は公共交通オープンデータセンター（ODPT）です。[開発者ガイドライン](https://developer.odpt.org/terms/data_basic_use_guideline.html)に従い、動的データの生成時刻、更新頻度、有効期間を確認して運用してください。GTFS-RTフィードの生成時刻はFeedHeader.timestampから表示します。ライセンスと事業者別条件はデータカタログの各データ項目も確認してください。

## 次の便・運番予測（履歴収集）

次の便と仮運番は、GTFS-Realtimeで観測した車両ごとの便の並びを蓄積して推定します。GTFS-JPに運用ブロックがない場合でも履歴から候補を作れますが、開始直後は履歴がないため候補が出ません。日ごとの運行パターンを確定して運番を付けるのは翌朝4時台です。予測は過去実績に基づく目安です。

仮運番の形式は `営業所記号-グループ小文字-番号`（例: `A-a-001`）です。車両ID（例: `A608`）は車庫別一覧の局番と照合し、現在の配置先の営業所記号を取得します。局番を所属記号と導入時期記号まで含めて `P-A608` と書く場合、その配置先はP（巣鴨）です。対応表は[都営バス資料館の車庫別車両一覧](https://toeibus.com/archives/17807)から作成してSupabaseに保存し、24時間ごとにページを再取得します。資料館に掲載されている配置情報は2026年5月1日現在のため、実際の異動が資料館側に反映されるまで差が出る場合があります。仮運番はサイト独自の推定値で、都営バス公式の運番との一致を保証しません。

### Supabaseの用意

1. SupabaseでFreeプランのプロジェクトを作成します。
2. プロジェクトのSQL Editorで `supabase/migrations/202611180001_vehicle_operations.sql` の全文を実行します。
3. Project SettingsのAPI画面からProject URLと`service_role`キーを取得します。`service_role`キーは管理者用の秘密情報なので、公開場所やブラウザー側の変数に入れないでください。

### GitHub Actionsの定期収集

GitHubリポジトリで Settings → Secrets and variables → Actions → New repository secret を選び、次の4つを登録します。

- `ODPT_API_KEY`: ODPT APIキー
- `ODPT_VEHICLE_POSITIONS_URL`: ODPTカタログに表示されたVehiclePositionのURL
- `SUPABASE_URL`: Supabase Project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabaseのservice_roleキー

`.github/workflows/collect-operations.yml` は、必要な設定を入れるまで定期実行を停止しています。ODPT APIキー・VehiclePosition URL・Supabase URL・Supabase service_roleキーの4つをRepository secretsに登録し、Actions Variablesに `OPERATIONS_COLLECTION_ENABLED=true` を追加すると5分おきの収集が始まります。設定後はActionsタブで `Collect Toei bus operations` を開き、`Run workflow` から初回実行もできます。GitHubのスケジュール実行は混雑時に遅れることがあります。Publicリポジトリの無料枠やGitHubの現行条件は利用状況により変わるため、Actionsの使用量を確認してください。

### Vercelの設定

VercelのProject Settings → Environment Variablesに以下を追加し、Productionを選択して保存後に再デプロイします。

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

既存のODPT環境変数はそのまま使います。Supabaseキーを`NEXT_PUBLIC_`付きで登録しないでください。サイトの車両詳細に履歴からの次便候補と仮運番が表示されます。運行履歴が貯まるまで、予測候補が表示されない期間があります。

Supabase無料プロジェクトは利用状況に応じて一時停止される場合があります。停止すると収集と予測表示が止まるため、Supabaseの状態を確認してください。
