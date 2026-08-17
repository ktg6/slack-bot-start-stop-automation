# 新しい環境（environment）を追加する

Slackモーダルで選択できる環境を増やす手順。

## 変更箇所

1. **`lambdas/slack-handler/index.ts`**
   - `ENVIRONMENTS` 配列に `{ text: "env名", value: "env名" }` を追加

2. **`terraform/ssm.tf`**
   - 新環境の EC2/RDS インスタンスIDを Parameter Store に追加

3. **`terraform/variables.tf`**
   - 新環境の EC2/RDS インスタンスID 変数を追加

4. **`terraform/terraform.tfvars`**（gitignore対象）
   - 実際のインスタンスIDを設定

## 注意（Outlookカレンダー連携について）

`lambdas/outlook-sync/index.ts` の対象環境は `OUTLOOK_ENVIRONMENT = "dev"` に固定されており、
`ENVIRONMENTS` 配列は存在しない。カレンダー予定の件名からの環境判定も行っていない
（開始時刻→起動、終了時刻→停止として dev 環境にのみルール登録される）。
Outlookカレンダー経由で新環境を操作対象にしたい場合は、`OUTLOOK_ENVIRONMENT` 定数の変更、
または予定の件名から環境を解決するロジックの追加実装が別途必要。
