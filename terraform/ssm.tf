# ---------- Parameter Store (環境別リソース設定) ----------

# dev環境のEC2インスタンスID
resource "aws_ssm_parameter" "dev_ec2_instance_ids" {
  name  = "/start-stop/dev/ec2-instance-ids"
  type  = "String"
  value = aws_instance.demo.id
}

# dev環境のRDSインスタンスID
resource "aws_ssm_parameter" "dev_rds_instance_id" {
  name  = "/start-stop/dev/rds-instance-id"
  type  = "String"
  value = aws_db_instance.demo.identifier
}

# staging環境のEC2/RDSインスタンスID
resource "aws_ssm_parameter" "staging_ec2_instance_ids" {
  name  = "/start-stop/staging/ec2-instance-ids"
  type  = "String"
  value = var.staging_ec2_instance_ids
}

resource "aws_ssm_parameter" "staging_rds_instance_id" {
  name  = "/start-stop/staging/rds-instance-id"
  type  = "String"
  value = var.staging_rds_instance_id
}

# prod環境のEC2/RDSインスタンスID
resource "aws_ssm_parameter" "prod_ec2_instance_ids" {
  name  = "/start-stop/prod/ec2-instance-ids"
  type  = "String"
  value = var.prod_ec2_instance_ids
}

resource "aws_ssm_parameter" "prod_rds_instance_id" {
  name  = "/start-stop/prod/rds-instance-id"
  type  = "String"
  value = var.prod_rds_instance_id
}

# Slack設定
resource "aws_ssm_parameter" "slack_channel_id" {
  name  = "/start-stop/slack-channel-id"
  type  = "String"
  value = var.slack_channel_id
}

resource "aws_ssm_parameter" "slack_bot_token" {
  count = var.slack_bot_token != "" ? 1 : 0
  name  = "/start-stop/slack-bot-token"
  type  = "SecureString"
  value = var.slack_bot_token
}

resource "aws_ssm_parameter" "slack_signing_secret" {
  count = var.slack_signing_secret != "" ? 1 : 0
  name  = "/start-stop/slack-signing-secret"
  type  = "SecureString"
  value = var.slack_signing_secret
}
