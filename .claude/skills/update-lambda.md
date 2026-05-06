# Lambda関数のコードを更新する

## ビルド〜デプロイの流れ

```bash
# 1. ビルド
cd lambdas
npm run build   # TypeScript → dist/

# 2. パッケージング
npm run package # dist/ → lambda-package.zip

# 3. 関数を指定してアップロード
aws lambda update-function-code \
  --function-name start-stop-<対象Lambda名> \
  --zip-file fileb://lambda-package.zip
```

## 注意点
- ビルドエラーがある場合はデプロイしない
- handler パスは `tsconfig.json` の outDir 設定（`dist/`）と一致させる
- 環境変数の変更は Terraform 側で管理する（Lambda コンソールで直接変更しない）
