# セキュリティルール

- Slack Token / Signing Secret / AWS credentials / Microsoft Client Secret を**コードにハードコードしない**
- 機微情報は SSM Parameter Store（SecureString）または環境変数経由で渡す
- `.env` / `*.tfvars` / `*.pem` / `*.key` はコミット前に .gitignore に含まれているか確認する
- IAMポリシーは最小権限の原則に従い、`"Resource": "*"` の使用は必要最小限にする
- Lambda Function URLは `AuthorizationType: NONE` のため、Slack署名検証を必ず実装する
