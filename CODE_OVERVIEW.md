# コード概要・説明ドキュメント

生成日: 2026-04-11

---

## 1. システム全体の概要

SlackからAWSリソース（EC2/RDS）の起動・停止を操作する自動化システム。
Outlookカレンダーとの連携によるスケジュール実行にも対応する。

```
[Slack] ──slash command──▶ [slack-handler Lambda]
                                    │
                                    ▼
                           [Step Functions]
                                    │
                          ┌─────────┼─────────┐
                          ▼         ▼         ▼
                      [EC2操作] [RDS操作] [Slack通知]
                      (resource-operator Lambda)

[Outlook Calendar] ──1時間毎──▶ [outlook-sync Lambda]
                                        │
                                        ▼
                               [EventBridge Rule 動的作成]
                                        │
                                        ▼
                              [sfn-trigger Lambda]
                                        │
                                        ▼
                               [Step Functions]
```

---

## 2. ディレクトリ構造

```
slack-bot-start-stop-automation/
├── lambdas/                        # Lambda関数群（TypeScript）
│   ├── slack-handler/index.ts      # Slackイベント受信・処理
│   ├── resource-operator/index.ts  # EC2/RDS操作とSlack通知
│   ├── sfn-trigger/index.ts        # EventBridge→Step Functions橋渡し
│   ├── outlook-sync/index.ts       # Outlookカレンダー同期
│   ├── package.json
│   └── tsconfig.json
├── step-functions/
│   └── definition.asl.json         # ワークフロー定義（ASL）
└── terraform/                      # インフラ定義（IaC）
    ├── main.tf                     # VPC/EC2/RDS（デモ用）
    ├── lambda.tf                   # Lambda関数リソース
    ├── iam.tf                      # IAMロール・ポリシー
    ├── step-functions.tf           # State Machine
    ├── eventbridge.tf              # EventBridge（Outlook同期スケジュール）
    ├── ssm.tf                      # SSM Parameter Store
    ├── variables.tf                # 変数定義
    └── outputs.tf                  # 出力値
```

---

## 3. Lambda 関数

### 3-1. `lambdas/slack-handler/index.ts`（162行）

**役割**: Slackからのリクエストを受信し、モーダルUIを提供してStep Functionsを起動する。

**使用ライブラリ**
- `@slack/bolt` — Slack App フレームワーク（署名検証・イベントルーティング）
- `@aws-sdk/client-sfn` — Step Functions 起動
- `@aws-sdk/client-ssm` — SSM Parameter Store からリソースID取得

**処理フロー**

```
1. /start-stop コマンド受信
   └─▶ モーダルUI表示（アクション選択: 起動/停止, 環境選択: dev/staging/prod）

2. モーダル送信（start_stop_modal）
   ├─▶ SSM から ec2-instance-ids / rds-instance-id を取得
   │     パス: /start-stop/{environment}/ec2-instance-ids
   │           /start-stop/{environment}/rds-instance-id
   ├─▶ Step Functions 起動
   │     Input: { action, environment, ec2InstanceIds[], rdsInstanceId, userId }
   └─▶ Slack チャンネルに即時通知（「〇〇が△△環境の起動処理を開始しました」）
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
// Lambda Function URL 経由で呼ばれる
export const handler = async (event, context, callback) => { ... }
```

---

### 3-2. `lambdas/resource-operator/index.ts`（150行）

**役割**: Step Functionsの各ステートから呼ばれ、EC2/RDS操作とSlack通知を担当する多目的Lambda。

**受け付ける operation**

| operation    | 処理内容                              | 戻り値 ready |
|-------------|--------------------------------------|------------|
| `start_ec2`  | EC2インスタンスを起動（StartInstances） | false（開始のみ）|
| `stop_ec2`   | EC2インスタンスを停止（StopInstances）  | false（開始のみ）|
| `check_ec2`  | EC2状態確認（running / stopped）       | true/false |
| `start_rds`  | RDSインスタンスを起動（StartDBInstance）| false（開始のみ）|
| `stop_rds`   | RDSインスタンスを停止（StopDBInstance） | false（開始のみ）|
| `check_rds`  | RDS状態確認（available / stopped）     | true/false |
| `notify`     | Slackチャンネルに完了/エラー通知         | true（常に）|

**入力型**
```typescript
interface OperationEvent {
  operation: "start_ec2" | "stop_ec2" | "start_rds" | "stop_rds"
           | "check_ec2" | "check_rds" | "notify";
  ec2InstanceIds: string[];   // 複数インスタンス対応
  rdsInstanceId: string;
  action: "start" | "stop";
  environment: string;
  userId: string;
  error?: string;             // エラー通知時のみ使用
}
```

**Slack通知フォーマット**
- 成功: `:white_check_mark: [dev] 起動処理が完了しました\n実行者: @user`
- 失敗: `:x: [dev] 起動処理でエラーが発生しました\n実行者: @user\nエラー: ...`

---

### 3-3. `lambdas/sfn-trigger/index.ts`（22行）

**役割**: EventBridgeのターゲットとして呼ばれ、Step Functionsを起動する薄いラッパー。

**処理内容**
EventBridgeが直接Step Functionsを起動できるが、このLambdaを経由することでEventBridgeルール単位で権限管理をシンプルにしている。

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

### 3-4. `lambdas/outlook-sync/index.ts`（346行）

**役割**: Outlookカレンダーを1時間ごとにポーリングし、件名パターンにマッチするイベントからEventBridgeルールを動的に作成・削除する。

**処理フロー**
```
1. Microsoft Graph API でアクセストークン取得（Client Credentials Flow）
2. calendarView API で過去7日〜60日後のイベントを取得
3. 件名パターン "[環境名] 起動|停止" にマッチするイベントを解析
   例: "[dev] 起動", "[staging] 停止"
4. 現在のEventBridgeルール（prefix: "start-stop-"）と比較
   - 不要になったルールを削除
   - 新規に必要なルールを作成
5. JST 9時台の実行時のみ、当日のスケジュールをSlackに通知
```

**ルール名の命名規則**
```
start-stop-{environment}-{action}-{YYYYMMDD}-{HHMM}
例: start-stop-dev-start-20260411-1000
```

**時刻変換ロジック**（既知の制限: JST固定）
```typescript
// Outlookが返すローカル時刻（タイムゾーン情報なし）を UTC に変換
const startTime = new Date(event.start.dateTime + "Z"); // UTC として解釈
const jstOffset = 9 * 60 * 60 * 1000;
const utcTime = new Date(startTime.getTime() - jstOffset); // JST→UTC
// ⚠️ timeZone フィールドは無視しているため、JST以外のカレンダーでは誤動作する
```

**EventBridgeルール作成時の処理**
```
PutRule（cron式で1回限り実行）
  └─▶ PutTargets（sfn-trigger Lambda をターゲットに設定）
        └─▶ AddPermission（Lambda に EventBridge からの実行権限を付与）
```

**ルール上限管理**
```typescript
const maxRules = parseInt(process.env.MAX_RULES ?? "40", 10);
// EventBridge のデフォルト上限（300）の手前で制御
```

---

## 4. Step Functions ワークフロー

### `step-functions/definition.asl.json`（252行）

**全体フロー**

```
DetermineAction
  ├─ action="start" ──▶ StartEC2
  │                         └─▶ WaitEC2Start(30s) ──▶ CheckEC2Running
  │                                                         └─▶ IsEC2Running
  │                                                               ├─ ready=true ──▶ StartRDS
  │                                                               │                    └─▶ WaitRDSStart(60s) ──▶ CheckRDSAvailable
  │                                                               │                                                   └─▶ IsRDSAvailable
  │                                                               │                                                         ├─ ready=true ──▶ NotifyComplete
  │                                                               │                                                         └─ ready=false ──▶ WaitRDSStart（ループ）
  │                                                               └─ ready=false ──▶ WaitEC2Start（ループ）
  │
  └─ action="stop" ──▶ StopRDS
                           └─▶ WaitRDSStop(60s) ──▶ CheckRDSStopped
                                                          └─▶ IsRDSStopped
                                                                ├─ ready=true ──▶ StopEC2
                                                                │                    └─▶ WaitEC2Stop(30s) ──▶ CheckEC2Stopped
                                                                │                                                 └─▶ IsEC2Stopped
                                                                │                                                       ├─ ready=true ──▶ NotifyComplete
                                                                │                                                       └─ ready=false ──▶ WaitEC2Stop（ループ）
                                                                └─ ready=false ──▶ WaitRDSStop（ループ）

全ステート共通 Catch ──▶ HandleError ──▶ NotifyError
```

**起動順序（start）**: EC2 → (running確認) → RDS → (available確認) → 完了通知
**停止順序（stop）**: RDS → (stopped確認) → EC2 → (stopped確認) → 完了通知

**既知の問題点**
1. 待機ループに上限なし — EC2/RDSが異常状態だと無限ループになりコスト増の恐れあり
2. HandleError で `$.operationResult` を参照しているが、Catch時の情報は `$.Error`/`$.Cause` に入るため詳細が取得できない
3. NotifyError は固定文字列のため、エラー原因がSlackに届かない

---

## 5. Terraform インフラ定義

### 5-1. `terraform/main.tf`（141行）

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
| `aws_db_instance.demo` | デモ用RDS（MySQL 8.0, db.t3.micro） |

> デモ用の最小構成。実運用では既存VPC/リソースを参照するよう変更が必要。

---

### 5-2. `terraform/lambda.tf`（120行）

**作成するLambda関数**

| 関数名 | handler | timeout | 環境変数 |
|-------|---------|---------|---------|
| `{project}-slack-handler` | `slack-handler/index.handler` | 30s | BOT_TOKEN, SIGNING_SECRET, CHANNEL_ID, SFN_ARN |
| `{project}-resource-operator` | `resource-operator/index.handler` | 120s | BOT_TOKEN, CHANNEL_ID |
| `{project}-outlook-sync` | `outlook-sync/index.handler` | 120s | BOT_TOKEN, CHANNEL_ID, SFN_ARN, OUTLOOK_*, SFN_TRIGGER_ARN |
| `{project}-sfn-trigger` | `sfn-trigger/index.handler` | 10s | SFN_ARN |

**デプロイ戦略**
- 初回 `terraform apply` はダミーzip（`data.archive_file.dummy`）でリソース作成
- 以降は `lifecycle { ignore_changes = [filename, source_code_hash] }` でTerraformが上書きしない
- コードは `aws lambda update-function-code` で別途デプロイ

**Function URL**
- `slack-handler` のみ Function URL を作成（`authorization_type = "NONE"` でパブリックアクセス）
- この URL を Slack App の Request URL に設定する

---

### 5-3. `terraform/iam.tf`（161行）

**各LambdaのIAMポリシー**

| Lambda | 許可されている操作 |
|--------|----------------|
| slack-handler | `states:StartExecution`, `ssm:GetParameter /start-stop/*`, CloudWatch Logs |
| resource-operator | `ec2:Start/Stop/DescribeInstances`, `rds:Start/Stop/DescribeDBInstances`, CloudWatch Logs |
| outlook-sync | `events:PutRule/DeleteRule/PutTargets/RemoveTargets/List*`, `lambda:AddPermission/RemovePermission`, `ssm:GetParameter`, CloudWatch Logs |
| sfn-trigger | `states:StartExecution`, CloudWatch Logs |
| Step Functions | `lambda:InvokeFunction`（resource-operatorのみ） |

---

### 5-4. `terraform/ssm.tf`（60行）

**登録パラメータ**

| パラメータ名 | 型 | 内容 |
|------------|---|------|
| `/start-stop/dev/ec2-instance-ids` | String | デモEC2のID（Terraformリソース参照） |
| `/start-stop/dev/rds-instance-id` | String | デモRDSのID（Terraformリソース参照） |
| `/start-stop/staging/ec2-instance-ids` | String | staging EC2 ID（変数: デフォルト "placeholder"） |
| `/start-stop/staging/rds-instance-id` | String | staging RDS ID（変数: デフォルト "placeholder"） |
| `/start-stop/prod/ec2-instance-ids` | String | prod EC2 ID（変数: デフォルト "placeholder"） |
| `/start-stop/prod/rds-instance-id` | String | prod RDS ID（変数: デフォルト "placeholder"） |
| `/start-stop/slack-channel-id` | String | Slackチャンネルか（参照用） |
| `/start-stop/slack-bot-token` | SecureString | Slack Bot Token |
| `/start-stop/slack-signing-secret` | SecureString | Slack署名シークレット |

> staging/prod は `terraform.tfvars` で実際のリソースIDを上書きして使用する。

---

### 5-5. `terraform/eventbridge.tf`（20行）

Outlookカレンダー同期をトリガーするための固定スケジュール。

```hcl
# 1時間ごとに outlook-sync Lambda を実行
schedule_expression = "rate(1 hour)"
```

> outlook-sync が動的に作成/削除するEventBridgeルール（`start-stop-` prefix）とは別物。

---

### 5-6. `terraform/step-functions.tf`（9行）

```hcl
# definition.asl.json を templatefile で読み込み、${ResourceOperatorArn} を置換
definition = templatefile("${path.module}/../step-functions/definition.asl.json", {
  ResourceOperatorArn = aws_lambda_function.resource_operator.arn
})
```

---

### 5-7. `terraform/variables.tf`（111行）

**必須変数（デフォルト値なし）**

| 変数名 | 説明 |
|-------|------|
| `slack_bot_token` | Slack Bot Token（`xoxb-...`） |
| `slack_signing_secret` | Slack Signing Secret |
| `slack_channel_id` | 通知先チャンネルID |
| `rds_master_password` | RDSマスターパスワード |

**オプション変数（デフォルト値あり）**

| 変数名 | デフォルト | 説明 |
|-------|----------|------|
| `aws_region` | ap-northeast-1 | AWSリージョン |
| `project_name` | start-stop | リソース名プレフィックス |
| `outlook_tenant_id` | "" | Microsoft Entra Tenant ID |
| `outlook_client_id` | "" | Microsoft Entra App Client ID |
| `outlook_client_secret` | "" | Microsoft Entra App Client Secret |
| `outlook_calendar_email` | "" | カレンダーオーナーのメールアドレス |
| `staging_ec2_instance_ids` | "placeholder" | staging EC2 ID |
| `staging_rds_instance_id` | "placeholder" | staging RDS ID |
| `prod_ec2_instance_ids` | "placeholder" | prod EC2 ID |
| `prod_rds_instance_id` | "placeholder" | prod RDS ID |
| `ec2_ami_id` | ami-0d52744d6551d851e | デモ用AMI（Amazon Linux 2023） |
| `ec2_instance_type` | t3.micro | デモ用インスタンスタイプ |
| `rds_instance_class` | db.t3.micro | デモ用DBインスタンスクラス |
| `rds_master_username` | admin | DBマスターユーザー名 |

---

### 5-8. `terraform/outputs.tf`（24行）

| 出力値 | 内容 |
|-------|------|
| `slack_handler_function_url` | **Slack App の Request URL に設定する URL** |
| `ec2_instance_id` | デモEC2のインスタンスID |
| `rds_instance_id` | デモRDSのインスタンスID |
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
    "outDir": "./dist",
    "rootDir": "."
  }
}
```

ビルド後のファイル配置:
```
lambdas/dist/
├── slack-handler/index.js
├── resource-operator/index.js
├── sfn-trigger/index.js
└── outlook-sync/index.js
```

Lambda handler パス（上記ディレクトリ構造と対応）:
- `slack-handler/index.handler`
- `resource-operator/index.handler`
- `sfn-trigger/index.handler`
- `outlook-sync/index.handler`

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
  │ /start-stop
  ▼
slack-handler（Function URL）
  │ SSM から ec2/rds ID 取得
  │ Step Functions 起動
  ▼
Step Functions
  │ resource-operator を順次呼び出し
  ├─ start_ec2 / stop_rds
  ├─ check_ec2 / check_rds（ポーリング）
  └─ notify（完了/エラーをSlack通知）
```

### 自動操作（Outlookカレンダー経由）
```
Outlook Calendar
  │ 1時間ごと（EventBridge）
  ▼
outlook-sync Lambda
  │ Microsoft Graph API でイベント取得
  │ [環境名] 起動|停止 をパース
  │ EventBridge ルール作成（cron式・1回限り）
  ▼
EventBridge（スケジュール時刻）
  ▼
sfn-trigger Lambda
  ▼
Step Functions → （同上）
```

---

## 8. 既知の問題・改善点（Codexレビューより）

| 分類 | 内容 | 影響 |
|-----|------|------|
| ~~P1 修正済み~~ | sfn-trigger handler パス不一致 | Lambda実行時エラー（修正済み） |
| ~~P2 修正済み~~ | staging/prod SSM パラメータ不在 | 環境選択時にSSMエラー（修正済み） |
| P2 未対応 | SFN エラーパスで詳細情報が消失（`$.operationResult` 参照） | エラー原因がSlackに届かない |
| P2 未対応 | 待機ループに上限なし | リソース異常時にSFNが永続実行 |
| P2 未対応 | JST固定のタイムゾーン変換（`timeZone` 無視） | 他タイムゾーンで誤スケジュール |
