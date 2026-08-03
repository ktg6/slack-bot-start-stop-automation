# ---------- Outlook同期用スケジュール (JST 0時・12時) ----------
resource "aws_cloudwatch_event_rule" "outlook_sync" {
  name                = "${var.project_name}-outlook-sync"
  description         = "Trigger Outlook calendar sync at 00:00 and 12:00 JST (03:00 and 15:00 UTC)"
  schedule_expression = "cron(0 3,15 * * ? *)"
}

resource "aws_cloudwatch_event_target" "outlook_sync" {
  rule      = aws_cloudwatch_event_rule.outlook_sync.name
  target_id = "${var.project_name}-outlook-sync-target"
  arn       = aws_lambda_function.outlook_sync.arn
}

resource "aws_lambda_permission" "outlook_sync_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.outlook_sync.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.outlook_sync.arn
}
