# 新しい環境（environment）を追加する

Slackモーダルで選択できる環境を増やす手順。

## 変更箇所

1. **`lambdas/slack-handler/index.ts`**
   - `ENVIRONMENTS` 配列に `{ text: "env名", value: "env名" }` を追加

2. **`lambdas/outlook-sync/index.ts`**
   - `ENVIRONMENTS` 配列に環境名を追加

3. **`terraform/ssm.tf`**
   - 新環境の EC2/RDS インスタンスIDを Parameter Store に追加

4. **`terraform/variables.tf`**
   - 新環境の EC2/RDS インスタンスID 変数を追加

5. **`terraform/variables.tfvars`**（gitignore対象）
   - 実際のインスタンスIDを設定
