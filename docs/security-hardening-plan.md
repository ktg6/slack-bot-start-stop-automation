# Security Hardening Plan

このドキュメントは次の3点をまとめた実施手順です。

1. Terraform backend を `S3 + KMS + lock` に移行
2. README の `rds_master_password` 旧記述を除去
3. Slack/Outlook 秘密値を Secrets Manager 読み出し方式へ寄せる最小変更案

## 1. Terraform Backend 移行手順

### 目的

- `terraform.tfstate` のローカル保存をやめる
- state の暗号化、履歴管理、排他制御を有効化する

### 事前に作るリソース

- S3 Bucket（state保存用）
- KMS Key（S3 SSE-KMS 用）
- lock テーブル
  - 推奨: Terraform 1.10+ なら S3 lockfile (`use_lockfile = true`)
  - 互換重視: DynamoDB lock（既存運用で広く利用）

### backend 設定ファイル（例）

`terraform/backend.hcl`（Git管理しない）

```hcl
bucket         = "start-stop-tfstate-prod"
key            = "start-stop/terraform.tfstate"
region         = "ap-northeast-1"
encrypt        = true
kms_key_id     = "arn:aws:kms:ap-northeast-1:123456789012:key/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
use_lockfile   = true
```

### 初回移行手順

```bash
cd terraform
terraform init -reconfigure -backend-config=backend.hcl
terraform state pull > /tmp/tfstate.backup.json
terraform plan
```

### 運用ルール

- `terraform.tfstate*` は Git に含めない
- `backend.hcl` は Git に含めない
- state 参照権限は最小化する（特に `GetObject`/`PutObject`）

## 2. README 修正内容

実施済み:

- `rds_master_password` の tfvars 記述を削除
- `terraform output rds_master_user_secret_arn` の確認手順を追加

## 3. Secrets Manager への最小変更案（Slack/Outlook）

## 目標

- `slack_bot_token`
- `slack_signing_secret`
- `outlook_client_secret`

上記を Terraform variable 直渡しから Secrets Manager 読み出しに変更する。

## 変更方針（最小）

1. Secrets Manager に 3つの secret を事前作成
2. Terraform は「secret ARN だけ」を Lambda 環境変数に渡す
3. Lambda 起動時に `GetSecretValue` で取得する
4. IAM に `secretsmanager:GetSecretValue` を付与する

## Terraform 差分イメージ

### variables 追加（ARN受け取り）

```hcl
variable "slack_bot_token_secret_arn" {
  description = "Secrets Manager ARN for Slack bot token"
  type        = string
}

variable "slack_signing_secret_secret_arn" {
  description = "Secrets Manager ARN for Slack signing secret"
  type        = string
}

variable "outlook_client_secret_secret_arn" {
  description = "Secrets Manager ARN for Outlook client secret"
  type        = string
  default     = ""
}
```

### lambda 環境変数

`SLACK_BOT_TOKEN` のような値そのものは渡さず、`*_SECRET_ARN` を渡す:

```hcl
environment {
  variables = {
    SLACK_BOT_TOKEN_SECRET_ARN      = var.slack_bot_token_secret_arn
    SLACK_SIGNING_SECRET_SECRET_ARN = var.slack_signing_secret_secret_arn
  }
}
```

`outlook-sync` には次も追加:

```hcl
OUTLOOK_CLIENT_SECRET_SECRET_ARN = var.outlook_client_secret_secret_arn
```

### IAM 追加

各 Lambda ロールに `secretsmanager:GetSecretValue` を追加:

```hcl
statement {
  actions   = ["secretsmanager:GetSecretValue"]
  resources = [
    var.slack_bot_token_secret_arn,
    var.slack_signing_secret_secret_arn,
    var.outlook_client_secret_secret_arn
  ]
}
```

## TypeScript 差分イメージ

### 共通ヘルパ（例）

```ts
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const secrets = new SecretsManagerClient({});

export const getSecret = async (secretArn: string): Promise<string> => {
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  return result.SecretString ?? "";
};
```

### slack-handler

- `SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET` の直接参照をやめる
- `*_SECRET_ARN` を読んで secret 値を取得してから `App` を初期化

### resource-operator / outlook-sync

- `SLACK_BOT_TOKEN` を直接参照せず secret 取得に変更
- `outlook-sync` は `OUTLOOK_CLIENT_SECRET` も同様に変更

## tfvars 記載例（値ではなくARN）

```hcl
slack_bot_token_secret_arn             = "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:slack-bot-token-xxxx"
slack_signing_secret_secret_arn        = "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:slack-signing-secret-xxxx"
outlook_client_secret_secret_arn       = "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:outlook-client-secret-xxxx"
```

## 段階的移行の安全策

1. 先に Secrets Manager 側を作成
2. Lambda の新環境変数（`*_SECRET_ARN`）を追加
3. コードを「`*_SECRET_ARN` 優先、無ければ旧 env」互換にする
4. 動作確認後に旧 env (`SLACK_BOT_TOKEN` 等) を廃止

この順序なら、ダウンタイムや一括切り替え失敗リスクを最小化できる。
