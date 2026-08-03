# Language

- 日本語で回答

# Security

Never run:
- git push
- git commit
- sudo
- rm -rf

Never read:
- ~/.aws/*
- ~/.ssh/*
- .env*
- terraform.tfstate*

Never execute:
- terraform apply
- terraform destroy

# Output

- diff形式優先
- 変更理由を説明
- README更新禁止
- docs生成禁止
- 返答するメッセージは常体でコンパクトな内容にする
