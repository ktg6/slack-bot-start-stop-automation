# /tf-plan

Terraform の差分確認を行う（applyは行わない）。

```bash
cd terraform && terraform init -upgrade && terraform plan
```

plan結果を確認し、意図しないリソース変更がないか報告すること。
