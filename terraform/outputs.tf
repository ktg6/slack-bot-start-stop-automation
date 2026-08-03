output "slack_handler_function_url" {
  description = "Slack Bot用Lambda Function URL (SlackアプリのRequest URLに設定)"
  value       = aws_lambda_function_url.slack_handler.function_url
}

output "ec2_instance_id" {
  description = "デモ用EC2インスタンスID"
  value       = aws_instance.demo.id
}

output "rds_instance_id" {
  description = "デモ用RDSインスタンスID"
  value       = var.create_demo_rds ? aws_db_instance.demo[0].identifier : null
}

output "step_functions_arn" {
  description = "Step Functions State Machine ARN"
  value       = aws_sfn_state_machine.main.arn
}

output "outlook_sync_lambda_arn" {
  description = "Outlook同期Lambda ARN"
  value       = aws_lambda_function.outlook_sync.arn
}

output "rds_master_user_secret_arn" {
  description = "RDSマスターパスワードが格納されたSecrets Manager ARN（パスワード確認時に使用）"
  value       = var.create_demo_rds ? aws_db_instance.demo[0].master_user_secret[0].secret_arn : null
}
