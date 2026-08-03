# /deploy

Lambdaのビルドとデプロイを実行する。

## 手順

1. `cd lambdas && npm run build` でTypeScriptをビルド
2. `npm run package` でzipを作成
3. 各Lambda関数のコードを更新

```bash
aws lambda update-function-code \
  --function-name start-stop-slack-handler \
  --zip-file fileb://lambdas/lambda-package.zip

aws lambda update-function-code \
  --function-name start-stop-resource-operator \
  --zip-file fileb://lambdas/lambda-package.zip

aws lambda update-function-code \
  --function-name start-stop-outlook-sync \
  --zip-file fileb://lambdas/lambda-package.zip

aws lambda update-function-code \
  --function-name start-stop-sfn-trigger \
  --zip-file fileb://lambdas/lambda-package.zip
```
