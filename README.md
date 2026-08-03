# Slack Bot EC2/RDS 起動停止自動化

Slackコマンド・Outlookカレンダーから AWS EC2/RDS の起動・停止を自動化するデモプロジェクト。

## アーキテクチャ

```
Slack Channel ──/start-stop──▶ Lambda Function URL
                                    │
                              slack-handler Lambda
                              (Slack Bolt + モーダル)
                                    │
                              Step Functions
                              ┌─────┴─────┐
                         EC2 Start/   RDS Start/
                         Stop         Stop
                         (resource-operator Lambda)
                                    │
                              Slack通知 (完了/エラー)

EventBridge (1h毎) ──▶ outlook-sync Lambda
                            │
                      Outlook Graph API
                      カレンダー読み取り
                            │
                      EventBridgeルール
                      自動生成/削除
                            │
                      予定時刻に自動実行
```
## 前提条件

- AWS CLI 設定済み
- Terraform >= 1.5
- Node.js >= 20
- Slack App作成済み（Bot Token + Signing Secret）
- (任意) Microsoft Entra アプリ登録済み（Outlook連携用）

## Slack App 設定

1. [Slack API](https://api.slack.com/apps) でアプリ作成
2. **OAuth & Permissions** で以下のスコープを付与:
   - `chat:write` - メッセージ投稿
   - `commands` - スラッシュコマンド
3. **Slash Commands** で `/start-stop` を登録
   - Request URL: `terraform output` で出力される `slack_handler_function_url` を設定
4. **Interactivity & Shortcuts** を有効化
   - Request URL: 同上の `slack_handler_function_url` を設定
5. アプリを対象チャンネルにインストール

## Outlook 連携設定（任意）

1. [Microsoft Entra管理センター](https://entra.microsoft.com/) でアプリ登録
2. API権限を付与:
   - `Calendars.Read` (アプリケーション権限)
   - `User.Read.All` (アプリケーション権限)
3. 管理者の同意を付与
4. Client ID / Client Secret / Tenant ID を控える
5. Outlookカレンダーに以下の形式で予定を作成:
   - 件名: `[dev] 起動` or `[dev] 停止`
   - 開始時刻: 実行したい日時

## デプロイ

```bash
# 1. Lambda ビルド
cd lambdas
npm ci --ignore-scripts   # package-lock.json から確定的にインストール
npm run build

# 2. Lambdaパッケージ作成
npm run package

# 3. Terraform実行
cd ../terraform

# backend.hcl.example をコピーして backend.hcl を作成
cp backend.hcl.example backend.hcl
# backend.hcl の bucket / kms_key_id などを実環境の値に修正

# terraform.tfvars を作成
cat > terraform.tfvars <<EOF
slack_channel_id     = "C0XXXXXXXXX"

# 推奨: Secrets Manager ARNを指定（値そのものは渡さない）
slack_bot_token_secret_arn          = "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:slack-bot-token-xxxx"
slack_signing_secret_arn            = "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:slack-signing-secret-xxxx"

# Outlook連携（任意）
outlook_tenant_id      = ""
outlook_client_id      = ""
outlook_calendar_email = ""
outlook_client_secret_secret_arn = ""

# 互換用（段階移行時のみ）
# slack_bot_token      = "xoxb-your-token"
# slack_signing_secret = "your-signing-secret"
# outlook_client_secret  = ""
EOF

terraform init -reconfigure -backend-config=backend.hcl
terraform plan
terraform apply

# RDSマスターパスワードはAWSが自動生成し、
# Secrets Managerに保存される（手入力不要）
terraform output rds_master_user_secret_arn

# 4. Lambda関数のコード更新
aws lambda update-function-code \
  --function-name start-stop-slack-handler \
  --zip-file fileb://../lambdas/lambda-package.zip

aws lambda update-function-code \
  --function-name start-stop-resource-operator \
  --zip-file fileb://../lambdas/lambda-package.zip

aws lambda update-function-code \
  --function-name start-stop-outlook-sync \
  --zip-file fileb://../lambdas/lambda-package.zip

# 5. Slack AppのRequest URLを設定
terraform output slack_handler_function_url
```

## 使い方

### Slackコマンドから操作

1. Slackチャンネルで `/start-stop` を入力
2. モーダルが表示される
3. **アクション**（起動 / 停止）を選択
4. **環境**（dev / staging / prod）を選択
5. 「実行」をクリック
6. 処理開始の通知 → 完了通知がチャンネルに投稿される

### Outlookカレンダーから自動実行

1. Outlookカレンダーに予定を作成
   - 件名例: `[dev] 起動`, `[staging] 停止`
2. 1時間ごとにカレンダーが同期され、EventBridgeルールが自動生成
3. 予定時刻にStep Functionsが自動起動
4. 毎朝9時に当日の予定がSlackチャンネルに通知

## ディレクトリ構成

```
├── lambdas/
│   ├── slack-handler/     # Slackコマンド受信・モーダル表示
│   ├── resource-operator/ # EC2/RDS起動停止・ステータス確認
│   ├── outlook-sync/      # Outlookカレンダー同期・EventBridgeルール管理
│   └── sfn-trigger/       # EventBridge→Step Functions起動
├── step-functions/
│   └── definition.asl.json
└── terraform/
    ├── main.tf            # VPC/EC2/RDS (デモリソース)
    ├── lambda.tf          # Lambda + Function URL
    ├── step-functions.tf  # Step Functions
    ├── eventbridge.tf     # Outlook同期スケジュール
    ├── iam.tf             # IAMロール・ポリシー
    ├── ssm.tf             # Parameter Store
    ├── variables.tf
    └── outputs.tf
```

## コスト目安（デモ環境）

- **EC2** (t3.micro): ~$0.0136/時 (停止中は無料)
- **RDS** (db.t3.micro): ~$0.026/時 (停止中は無料)
- **Lambda**: 無料枠内（月100万リクエスト/40万GB秒）
- **Step Functions**: 無料枠内（月4,000回）
- **Lambda Function URL**: 無料（Lambda料金に含む）
