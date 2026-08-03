# Terraform ルール

- `terraform apply` / `terraform destroy` は**必ずユーザーの明示的な承認後**に実行する
- `terraform plan` の結果を必ず提示し、確認を取ること
- stateファイル・tfvarsファイルは絶対にコミットしない
- リソース削除（`destroy`）が含まれる変更は特に慎重に確認する
- `sensitive = true` の変数は出力・ログに表示しない
