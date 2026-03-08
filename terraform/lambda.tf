# ---------- Lambda パッケージ (ダミーzip - 初回apply用) ----------
data "archive_file" "dummy" {
  type        = "zip"
  output_path = "${path.module}/dummy.zip"

  source {
    content  = "exports.handler = async () => ({ statusCode: 200 });"
    filename = "index.js"
  }
}

# ---------- slack-handler Lambda ----------
resource "aws_lambda_function" "slack_handler" {
  function_name = "${var.project_name}-slack-handler"
  role          = aws_iam_role.slack_handler.arn
  handler       = "slack-handler/index.handler"
  runtime       = "nodejs20.x"
  timeout       = 30
  memory_size   = 256

  filename         = data.archive_file.dummy.output_path
  source_code_hash = data.archive_file.dummy.output_base64sha256

  environment {
    variables = {
      SLACK_BOT_TOKEN      = var.slack_bot_token
      SLACK_SIGNING_SECRET = var.slack_signing_secret
      SLACK_CHANNEL_ID     = var.slack_channel_id
      STEP_FUNCTIONS_ARN   = aws_sfn_state_machine.main.arn
    }
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

# Lambda Function URL (API Gateway代替)
resource "aws_lambda_function_url" "slack_handler" {
  function_name      = aws_lambda_function.slack_handler.function_name
  authorization_type = "NONE"
}

# ---------- resource-operator Lambda ----------
resource "aws_lambda_function" "resource_operator" {
  function_name = "${var.project_name}-resource-operator"
  role          = aws_iam_role.resource_operator.arn
  handler       = "resource-operator/index.handler"
  runtime       = "nodejs20.x"
  timeout       = 120
  memory_size   = 256

  filename         = data.archive_file.dummy.output_path
  source_code_hash = data.archive_file.dummy.output_base64sha256

  environment {
    variables = {
      SLACK_BOT_TOKEN  = var.slack_bot_token
      SLACK_CHANNEL_ID = var.slack_channel_id
    }
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

# ---------- outlook-sync Lambda ----------
resource "aws_lambda_function" "outlook_sync" {
  function_name = "${var.project_name}-outlook-sync"
  role          = aws_iam_role.outlook_sync.arn
  handler       = "outlook-sync/index.handler"
  runtime       = "nodejs20.x"
  timeout       = 120
  memory_size   = 256

  filename         = data.archive_file.dummy.output_path
  source_code_hash = data.archive_file.dummy.output_base64sha256

  environment {
    variables = {
      SLACK_BOT_TOKEN        = var.slack_bot_token
      SLACK_CHANNEL_ID       = var.slack_channel_id
      STEP_FUNCTIONS_ARN     = aws_sfn_state_machine.main.arn
      OUTLOOK_TENANT_ID      = var.outlook_tenant_id
      OUTLOOK_CLIENT_ID      = var.outlook_client_id
      OUTLOOK_CLIENT_SECRET  = var.outlook_client_secret
      OUTLOOK_CALENDAR_EMAIL = var.outlook_calendar_email
      SFN_TRIGGER_LAMBDA_ARN = aws_lambda_function.sfn_trigger.arn
    }
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

# ---------- Step Functions トリガー Lambda ----------
# EventBridgeから呼ばれ、Step Functionsを起動する軽量Lambda
resource "aws_lambda_function" "sfn_trigger" {
  function_name = "${var.project_name}-sfn-trigger"
  role          = aws_iam_role.sfn_trigger.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 10
  memory_size   = 128

  filename         = data.archive_file.dummy.output_path
  source_code_hash = data.archive_file.dummy.output_base64sha256

  environment {
    variables = {
      STEP_FUNCTIONS_ARN = aws_sfn_state_machine.main.arn
    }
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}
