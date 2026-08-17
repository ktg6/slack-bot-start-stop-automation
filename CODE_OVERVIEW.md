# コード概要・説明ドキュメント

更新日: 2026-08-17

---

## 1. システム全体の概要

SlackからAWSリソース（EC2/RDS）の起動・停止を操作する自動化システム。
Outlookカレンダーとの連携によるスケジュール実行にも対応する。

```
[Slack] ──/start-stop──▶ [slack-handler Lambda（Function URL）]
                                    │ Slack署名検証（verifySlackRequest）
                                    ▼
                           [Step Functions]
                                    │
                          NotifyStarted（開始通知）
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                                 ▼
          ParallelStart                       ParallelStop
          （EC2起動 + RDS起動を並列実行）        （EC2停止 + RDS停止を並列実行）
                    │                                 │
          RDSの状態のみポーリング確認         RDSの状態のみポーリング確認
                    └───────────────┬───────────────┘
                                    ▼
                            NotifyComplete（完了通知）
                      （resource-operator Lambda）

(初回のみ) ブラウザ ──▶ [outlook-auth Lambda（Function URL）] ──▶ Microsoft Entra OAuth同意
                                                  │
                                      Secrets Manager（refresh token保存）

[EventBridge（1日2回: 0時/12時 JST）] ──▶ [outlook-sync Lambda]
                                        │ refresh tokenでGraph APIアクセストークン取得
                                        ▼
                               [EventBridge Rule 動的作成/削除]
                                        │
                                        ▼
                              [sfn-trigger Lambda]
                                        │
                                        ▼
                               [Step Functions]（同上）
```

---

## 2. ディレクトリ構造

```
slack-bot-start-stop-automation/
├── lambdas/                        # Lambda関数群（TypeScript）
│   ├── slack-handler/index.ts      # Slack Function URLのHTTPイベント処理
│   ├── resource-operator/index.ts  # EC2/RDS操作とSlack通知
│   ├── sfn-trigger/index.ts        # EventBridge→Step Functions橋渡し
│   ├── outlook-sync/index.ts       # Outlookカレンダー同期
│   ├── outlook-auth/index.ts       # Outlook OAuth（Authorization Code Flow）
│   ├── scripts/                    # ビルド・パッケージングスクリプト
│   ├── package.json
│   └── tsconfig.json
├── step-functions/
│   └── definition.asl.json         # ワークフロー定義（ASL）
└── terraform/                      # インフラ定義（IaC）
    ├── main.tf                     # VPC/EC2/RDS（デモ用）
    ├── lambda.tf                   # Lambda関数・Function URLリソース
    ├── iam.tf                      # IAMロール・ポリシー
    ├── step-functions.tf           # State Machine
    ├── eventbridge.tf              # EventBridge（Outlook同期スケジュール）
    ├── ssm.tf                      # SSM Parameter Store
    ├── backend.tf                  # S3バックエンド設定
    ├── backend.hcl.example         # バックエンド設定の雛形
    ├── variables.tf                # 変数定義
    └── outputs.tf                  # 出力値
```

---

## 3. Lambda 関数

### 3-1. `lambdas/slack-handler/index.ts`（257行）

**役割**: Lambda Function URLへのHTTPリクエストを直接処理し、Slack署名検証・モーダルUI提供・Step Functions起動を行う。

**使用ライブラリ**
- `@slack/bolt` — `App` と `verifySlackRequest` のみ使用（`AwsLambdaReceiver` は不使用）
- `@aws-sdk/client-sfn` — Step Functions 起動
- `@aws-sdk/client-ssm` — SSM Parameter Store からリソースID取得
- `@aws-sdk/client-secrets-manager` — Bot Token / Signing Secret 取得

**処理フロー**

```
1. Function URL（authorization_type = "NONE"）が APIGatewayProxyEventV2 形式でイベント受信
2. rawBody を取得（isBase64Encoded を考慮）、ヘッダーを小文字化
3. verifySlackRequest() で署名・タイムスタンプを検証
     └▶ 失敗時は例外 → catch で 500 応答（以降の処理は実行されない）
4. Content-Type に応じて body を解析（JSON or application/x-www-form-urlencoded）
     payload フィールドがあれば（モーダル操作系）JSON として再展開
5. app.processEvent({ body, ack }) で Bolt のイベントルーティングへ橋渡し（ack は Promise 化）

6. /start-stop コマンド受信
   └▶ body.channel_id !== SLACK_CHANNEL_ID なら実行を拒否（エフェメラルメッセージ）
   └▶ 一致すればモーダルUI表示（アクション選択: 起動/停止, 環境選択: dev/staging/prod）

7. モーダル送信（start_stop_modal）
   ├─▶ SSM から ec2-instance-ids / rds-instance-id を取得
   │     パス: /start-stop/{environment}/ec2-instance-ids
   │           /start-stop/{environment}/rds-instance-id
   ├─▶ Step Functions 起動
   │     Input: { action, environment, ec2InstanceIds[], rdsInstanceId, userId }
   └─▶ Step Functions 起動完了後に ack()（開始メッセージはStep Functions側のNotifyStartedが送信）
```

**環境定数**
```typescript
const ENVIRONMENTS = [
  { text: "dev",     value: "dev" },
  { text: "staging", value: "staging" },
  { text: "prod",    value: "prod" },
];
```

**エントリポイント**
```typescript
// Lambda Function URL 経由で呼ばれる（callback形式ではなくPromise形式）
export const handler = async (event: APIGatewayProxyEventV2, _context: Context) => { ... }
```

---

### 3-2. `lambdas/resource-operator/index.ts`（190行）

**役割**: Step Functionsの各ステートから呼ばれ、EC2/RDS操作とSlack通知を担当する多目的Lambda。

**受け付ける operation**

| operation      | 処理内容                              | 戻り値 ready |
|---------------|--------------------------------------|------------|
| `notify_start` | Slackチャンネルに「処理を開始しました」通知 | true（常に）|
| `start_ec2`    | EC2インスタンスを起動（StartInstances） | false（開始のみ）|
| `stop_ec2`     | EC2インスタンスを停止（StopInstances）  | false（開始のみ）|
| `check_ec2`    | EC2状態確認（running / stopped）       | true/false |
| `start_rds`    | RDSインスタンスを起動（StartDBInstance）| false（開始のみ）|
| `stop_rds`     | RDSインスタンスを停止（StopDBInstance） | false（開始のみ）|
| `check_rds`    | RDS状態確認（available / stopped）     | true/false |
| `notify`       | Slackチャンネルに完了/エラー通知         | true（常に）|

> `check_ec2` はStep Functions定義から現在呼び出されていない（後述4章参照）。

**入力型**
```typescript
interface OperationEvent {
  operation: "start_ec2" | "stop_ec2" | "start_rds" | "stop_rds"
           | "check_ec2" | "check_rds" | "notify" | "notify_start";
  ec2InstanceIds: string[];   // 複数インスタンス対応
  rdsInstanceId: string;
  action: "start" | "stop";
  environment: string;
  userId: string;
  error?: string;             // エラー通知時のみ使用
}
```

**Slack通知フォーマット**
- 開始: `:hourglass_flowing_sand: [dev] 起動処理を開始しました\n実行者: @user`
- 成功: `:white_check_mark: [dev] 起動処理が完了しました\n実行者: @user`
- 失敗: `:x: [dev] 起動処理でエラーが発生しました\n実行者: @user\nエラー: ...`

---

### 3-3. `lambdas/sfn-trigger/index.ts`（22行）

**役割**: EventBridgeのターゲットとして呼ばれ、Step Functionsを起動する薄いラッパー。変更なし。

```typescript
// EventBridgeから渡されるイベントをそのままStep Functionsに渡す
export const handler = async (event: TriggerEvent) => {
  await sfn.send(new StartExecutionCommand({
    stateMachineArn: stepFunctionsArn,
    input: JSON.stringify(event),
  }));
};
```

**入力型（EventBridgeのInputで設定）**
```typescript
interface TriggerEvent {
  action: "start" | "stop";
  environment: string;
  ec2InstanceIds: string[];
  rdsInstanceId: string;
  userId: string;   // outlook-automation 固定（自動実行時）
}
```

---

### 3-4. `lambdas/outlook-sync/index.ts`（467行）

**役割**: Outlookカレンダーを1日2回ポーリングし、予定の開始時刻・終了時刻からEventBridgeルールを動的に作成・削除する。

**認可方式（重要な変更点）**
- Client Credentials Flow ではなく、**OAuth 2.0 Refresh Token Flow**（委任アクセス）を使用
- refresh token は `outlook-auth` Lambda が初回認可時にSecrets Managerへ書き込んだものを読み出す
- アクセストークン取得のたびに新しい `refresh_token` が返れば、Secrets Managerへ書き戻してローテーションする

**処理フロー**
```
1. Secrets Manager から refresh token / client secret を取得しアクセストークンを取得
2. calendarView API で過去7日〜60日後のイベントを取得（Tokyo Standard Timeで取得）
3. 予定ごとに「開始時刻→起動ルール」「終了時刻→停止ルール」を機械的に生成
     ※ 件名は一切パースしない（件名は任意の文字列でよい）
     ※ 環境は OUTLOOK_ENVIRONMENT = "dev" に固定（件名で環境を指定する仕組みはない）
4. 現在のEventBridgeルール（prefix: "start-stop-"）と比較
   - 不要になったルールを削除
   - 新規に必要なルールを作成
5. ルール作成/削除があればSlackに変更内容を通知
6. JST 9時台の実行時のみ、当日のスケジュールをSlackに通知（※ 既知の不具合、8章参照）
```

**ルール名の命名規則**
```
start-stop-{environment}-{action}-{YYYYMMDD}-{HHMM}
例: start-stop-dev-start-20260411-1000
```

**時刻変換ロジック**（既知の制限: JST以外は非対応）
```typescript
const isUtcTimeZone = (timeZone: string): boolean =>
  ["UTC", "Coordinated Universal Time", "Etc/UTC"].includes(timeZone);

const toUtcDate = (dateTime: string, timeZone: string): Date => {
  if (isUtcTimeZone(timeZone)) return new Date(`${dateTime}Z`);
  // UTC以外は Tokyo Standard Time とみなしてオフセットを引く
  const jstDate = new Date(`${dateTime}Z`);
  return new Date(jstDate.getTime() - 9 * 60 * 60 * 1000);
};
// ⚠️ timeZone の値そのものは判定に使わず「UTCかそれ以外か」の二値でしか扱わないため、
//    JST以外のローカルタイムゾーンのカレンダーでは誤動作する
```

**EventBridgeルール作成時の処理**
```
PutRule（cron式で1回限り実行）
  └▶ PutTargets（sfn-trigger Lambda をターゲットに設定）
        └▶ AddPermission（Lambda に EventBridge からの実行権限を付与）
```

**ルール上限管理**
```typescript
const maxRules = parseInt(process.env.MAX_RULES ?? "40", 10);
// EventBridge のデフォルト上限（300）の手前で制御
```

---

### 3-5. `lambdas/outlook-auth/index.ts`（137行, 新規）

**役割**: Microsoft Entra ID への委任認可（OAuth 2.0 Authorization Code Flow）を行うLambda。`outlook-sync` が使うrefresh tokenを初回セットアップ時に取得するための専用エンドポイント。

**使用ライブラリ**
- `@aws-sdk/client-secrets-manager` — client secret / state署名鍵の取得、refresh tokenの保存
- `node:crypto`（`createHmac`, `timingSafeEqual`）— state値の署名・検証

**エンドポイント（Function URL, `authorization_type = "NONE"`）**

| パス | 処理 |
|-----|------|
| `GET /auth/start` | HMAC署名付きstate値を生成し、Microsoftの認可エンドポイントへ302リダイレクト |
| `GET /auth/callback` | state検証（`timingSafeEqual`）→ 認可コードをトークンに交換 → `/me` でメールアドレス確認 → `OUTLOOK_ALLOWED_USER_EMAIL` と不一致なら403 → refresh tokenをSecrets Managerに保存 |

**運用上の位置づけ**: `terraform apply` 後、初回のみ人手で `<outlook_auth_function_url>/auth/start` にブラウザでアクセスし、Outlookカレンダーの持ち主のMicrosoftアカウントでサインイン・同意する。以降は `outlook-sync` が自動でrefresh tokenをローテーションするため再認可は不要（refresh tokenが失効した場合を除く）。

---

## 4. Step Functions ワークフロー

### `step-functions/definition.asl.json`（241行）

**全体フロー**

```
DetermineAction（action分岐）
  └▶ NotifyStarted（resource-operator: notify_start, 開始通知）
        └▶ RouteAction（action再分岐）
              │
              ├─ start ──▶ ParallelStart
              │              ├─ StartEC2InParallel（start_ec2）
              │              └─ StartRDSInParallel（start_rds）
              │              └▶ WaitRDSStart(60s) ──▶ CheckRDSAvailable ──▶ IsRDSAvailable
              │                                                                ├ ready=true ──▶ NotifyComplete
              │                                                                └ ready=false ──▶ WaitRDSStart（ループ）
              │
              └─ stop  ──▶ ParallelStop
                             ├─ StopEC2InParallel（stop_ec2）
                             └─ StopRDSInParallel（stop_rds）
                             └▶ WaitRDSStop(60s) ──▶ CheckRDSStopped ──▶ IsRDSStopped
                                                                            ├ ready=true ──▶ NotifyComplete
                                                                            └ ready=false ──▶ WaitRDSStop（ループ）

全ステート共通 Catch ──▶ HandleError ──▶ NotifyError
```

**起動/停止順序（重要な変更点）**: 以前の「EC2→確認→RDS→確認」という直列実行から、**EC2とRDSを`Parallel`ステートで同時に起動/停止し、RDSの状態のみをポーリング確認する**設計に変わっている。EC2側の起動/停止完了は`check_ec2`が定義には存在するものの、現在のワークフローからは呼び出されておらず、完了確認をしていない。

**既知の問題点**
1. 待機ループに上限なし — EC2/RDSが異常状態だと無限ループになりコスト増の恐れあり
2. `HandleError` で `$.operationResult` を参照しているが、Catch時の情報は `$.Error`/`$.Cause` に入るため詳細が取得できない（未修正）
3. `NotifyError` は固定文字列のため、エラー原因がSlackに届かない
4. EC2の起動/停止完了をポーリング確認していない（RDS側のみを完了条件にしている）

---

## 5. Terraform インフラ定義

### 5-1. `terraform/main.tf`（145行）

**作成リソース**

| リソース | 内容 |
|--------|------|
| `aws_vpc.main` | 10.0.0.0/16 のVPC |
| `aws_subnet.public` | パブリックサブネット（10.0.1.0/24） |
| `aws_subnet.private_a/c` | プライベートサブネット×2（RDS用） |
| `aws_internet_gateway.main` | IGW |
| `aws_route_table.public` | パブリックルートテーブル |
| `aws_security_group.ec2/rds` | EC2/RDS用SG |
| `aws_instance.demo` | デモ用EC2（Amazon Linux 2023, t3.micro） |
| `aws_db_instance.demo` | デモ用RDS（MySQL 8.4, db.t3.micro） |

> デモ用の最小構成。実運用では既存VPC/リソースを参照するよう変更が必要。

---

### 5-2. `terraform/lambda.tf`（188行）

**作成するLambda関数**

| 関数名 | handler | timeout | 主な環境変数 |
|-------|---------|---------|---------|
| `{project}-slack-handler` | `slack-handler/index.handler` | 30s | `*_SECRET_ARN`, `SLACK_CHANNEL_ID`, `STEP_FUNCTIONS_ARN` |
| `{project}-resource-operator` | `resource-operator/index.handler` | 120s | `SLACK_BOT_TOKEN_SECRET_ARN`, `SLACK_CHANNEL_ID` |
| `{project}-outlook-sync` | `outlook-sync/index.handler` | 120s | `OUTLOOK_*`, `SFN_TRIGGER_LAMBDA_ARN`, `STEP_FUNCTIONS_ARN` |
| `{project}-outlook-auth` | `outlook-auth/index.handler` | 30s | `OUTLOOK_AUTHORITY`, `OUTLOOK_REDIRECT_URI`, `OUTLOOK_*_SECRET_ARN`, `OUTLOOK_ALLOWED_USER_EMAIL` |
| `{project}-sfn-trigger` | `sfn-trigger/index.handler` | 10s | `STEP_FUNCTIONS_ARN` |

**デプロイ戦略**
- 初回 `terraform apply` はダミーzip（`data.archive_file.dummy`）でリソース作成
- 以降は `lifecycle { ignore_changes = [filename, source_code_hash] }` でTerraformが上書きしない
- コードは `aws lambda update-function-code` で別途デプロイ

**Function URL（2つに増加）**
- `slack-handler` — Slack App の Request URL として使用
- `outlook-auth` — 初回OAuth認可用（`/auth/start`, `/auth/callback`）

両方とも `authorization_type = "NONE"` で公開し、対応する `aws_lambda_permission`（`lambda:InvokeFunctionUrl` + `lambda:InvokeFunction`）を明示的に付与している。アプリケーション層の署名検証（slack-handler）・state検証とメールアドレス許可リスト（outlook-auth）で保護する設計。

---

### 5-3. `terraform/iam.tf`（247行）

**各LambdaのIAMポリシー**

| Lambda | 許可されている操作 |
|--------|----------------|
| slack-handler | `states:StartExecution`, `ssm:GetParameter /start-stop/*`, Secrets Manager `GetSecretValue`（bot token/signing secret）, CloudWatch Logs |
| resource-operator | `ec2:Start/Stop/DescribeInstances`, `rds:Start/Stop/DescribeDBInstances`, Secrets Manager `GetSecretValue`（bot token）, CloudWatch Logs |
| outlook-sync | `events:PutRule/DeleteRule/PutTargets/RemoveTargets/List*`, `lambda:AddPermission/RemovePermission`, `ssm:GetParameter`, Secrets Manager `GetSecretValue`/`PutSecretValue`, CloudWatch Logs |
| outlook-auth | Secrets Manager `GetSecretValue`（client secret/state鍵）/`PutSecretValue`（refresh token）, CloudWatch Logs |
| sfn-trigger | `states:StartExecution`, CloudWatch Logs |
| Step Functions | `lambda:InvokeFunction`（resource-operatorのみ） |

> 各ロールのSecrets Manager権限は `local.*_secret_arns` を `compact()` して動的に構築しており、未設定（空文字）の変数は自動的にstatementから除外される。

---

### 5-4. `terraform/ssm.tf`（62行）

変更なし。dev/staging/prod環境のEC2/RDS IDとSlack設定をParameter Storeに登録する。

---

### 5-5. `terraform/eventbridge.tf`（20行）

Outlookカレンダー同期をトリガーするための固定スケジュール。

```hcl
# 1日2回（JST 0時・12時 = UTC 3時・15時）に outlook-sync Lambda を実行
schedule_expression = "cron(0 3,15 * * ? *)"
```

> outlook-sync が動的に作成/削除するEventBridgeルール（`start-stop-` prefix）とは別物。

---

### 5-6. `terraform/step-functions.tf`（9行）

変更なし。

```hcl
definition = templatefile("${path.module}/../step-functions/definition.asl.json", {
  ResourceOperatorArn = aws_lambda_function.resource_operator.arn
})
```

---

### 5-7. `terraform/variables.tf`（162行）

**必須変数（デフォルト値なし）**

| 変数名 | 説明 |
|-------|------|
| `slack_channel_id` | 通知先チャンネルID |
| `rds_master_username` はデフォルトあり（"admin"）。RDSマスターパスワードはAWSが自動生成しSecrets Managerに保存されるため変数としては存在しない |

**Secrets Manager ARN 系（推奨方式）**

| 変数名 | 説明 |
|-------|------|
| `slack_bot_token_secret_arn` | Slack Bot TokenのARN |
| `slack_signing_secret_arn` | Slack Signing SecretのARN |
| `outlook_client_secret_secret_arn` | Outlook Client SecretのARN |
| `outlook_refresh_token_secret_arn` | Outlook refresh tokenのARN |
| `outlook_state_secret_arn` | OAuth state署名鍵のARN |

**平文値（互換用・非推奨）**: `slack_bot_token` / `slack_signing_secret` / `outlook_client_secret` — Secrets Manager ARNが優先され、未設定時のみフォールバックで使用される。

**その他オプション変数（デフォルト値あり）**

| 変数名 | デフォルト | 説明 |
|-------|----------|------|
| `aws_region` | ap-northeast-1 | AWSリージョン |
| `project_name` | start-stop | リソース名プレフィックス |
| `outlook_tenant_id` / `outlook_client_id` | "" | Microsoft Entra アプリ情報 |
| `outlook_authority` | `https://login.microsoftonline.com/common` | OAuth認可エンドポイントのベースURL |
| `outlook_redirect_uri` | "" | OAuthコールバックURL（outlook-auth Function URL + `/auth/callback`） |
| `outlook_allowed_user_email` | "" | OAuth認可を許可するMicrosoftアカウントのメールアドレス |
| `outlook_calendar_email` | "" | **未使用（Lambda環境変数として渡されていない、レガシー変数）** |
| `staging_ec2_instance_ids` 等 | "placeholder" | staging/prod のEC2/RDS ID |
| `ec2_ami_id` | ami-0d52744d6551d851e | デモ用AMI（Amazon Linux 2023） |
| `ec2_instance_type` | t3.micro | デモ用インスタンスタイプ |
| `rds_instance_class` | db.t3.micro | デモ用DBインスタンスクラス |
| `create_demo_rds` | true | デモ用RDSを作成するか |

---

### 5-8. `terraform/outputs.tf`（34行）

| 出力値 | 内容 |
|-------|------|
| `slack_handler_function_url` | **Slack App の Request URL に設定する URL** |
| `outlook_auth_function_url` | **Outlook OAuth初回認可（`/auth/start`）に使うURL** |
| `ec2_instance_id` | デモEC2のインスタンスID |
| `rds_instance_id` | デモRDSのインスタンスID |
| `rds_master_user_secret_arn` | RDSマスターパスワードが格納されたSecrets Manager ARN |
| `step_functions_arn` | State Machine の ARN |
| `outlook_sync_lambda_arn` | outlook-sync Lambda の ARN |

---

## 6. ビルド設定

### `lambdas/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": [
    "slack-handler/**/*.ts",
    "resource-operator/**/*.ts",
    "outlook-sync/**/*.ts",
    "outlook-auth/**/*.ts",
    "sfn-trigger/**/*.ts"
  ],
  "exclude": ["node_modules", "dist"]
}
```

> `strict` 等の型チェック設定が追加され、`outlook-auth` が `include` に加わった。

ビルド後のファイル配置:
```
lambdas/dist/
├── slack-handler/index.js
├── resource-operator/index.js
├── sfn-trigger/index.js
├── outlook-sync/index.js
└── outlook-auth/index.js
```

Lambda handler パス（上記ディレクトリ構造と対応）:
- `slack-handler/index.handler`
- `resource-operator/index.handler`
- `sfn-trigger/index.handler`
- `outlook-sync/index.handler`
- `outlook-auth/index.handler`

### `lambdas/package.json` ビルドコマンド

```bash
npm run build    # tsc でコンパイル
npm run package  # tsc + dist/ をzipに圧縮 → lambda-package.zip
```

---

## 7. データフロー まとめ

### 手動操作（Slack経由）
```
User
  │ /start-stop（Function URLへPOST、Slack署名付き）
  ▼
slack-handler（署名検証 → channel_id検証 → モーダル表示 → 送信でSFN起動）
  │ SSM から ec2/rds ID 取得
  │ Step Functions 起動
  ▼
Step Functions
  │ resource-operator を呼び出し
  ├─ notify_start（開始通知）
  ├─ start_ec2 / start_rds（または stop_ec2 / stop_rds）を並列実行
  ├─ check_rds（ポーリング、readyになるまでループ）
  └─ notify（完了/エラーをSlack通知）
```

### 自動操作（Outlookカレンダー経由）
```
(初回のみ) 人手による認可
  │ ブラウザで outlook-auth の /auth/start にアクセス
  │ Microsoftアカウントでサインイン・同意
  ▼
outlook-auth（state検証 → メールアドレス許可リスト確認 → refresh token保存）

Outlook Calendar
  │ 1日2回（0時・12時 JST, EventBridge）
  ▼
outlook-sync Lambda
  │ refresh tokenでGraph APIアクセストークン取得
  │ 予定の開始時刻→起動、終了時刻→停止としてルール化（環境は dev 固定）
  │ EventBridge ルール作成（cron式・1回限り）
  ▼
EventBridge（スケジュール時刻）
  ▼
sfn-trigger Lambda
  ▼
Step Functions → （同上）
```

---

## 8. 既知の問題・改善点

| 分類 | 内容 | 影響 |
|-----|------|------|
| P2 未対応 | SFN エラーパスで詳細情報が消失（`$.operationResult` 参照） | エラー原因がSlackに届かない |
| P2 未対応 | 待機ループに上限なし | リソース異常時にSFNが永続実行 |
| P2 未対応 | JST固定のタイムゾーン変換（UTC以外は一律JST扱い） | 他タイムゾーンで誤スケジュール |
| P2 未対応 | EC2側の起動/停止完了をポーリング確認していない（RDSのみ） | EC2起動前にRDS側の条件だけで完了通知される可能性 |
| P3 要確認 | `outlook-sync` の当日予定通知（`jstHour === 9` 判定）は、Lambda自体が0時・12時JSTにしか実行されないため実質発火しない | 「毎朝9時に当日予定を通知」という想定機能が動作していない可能性 |
| P3 未使用 | `outlook_calendar_email` 変数はLambda環境変数として渡されておらず未使用 | 実害なし（レガシー変数の削除候補） |
