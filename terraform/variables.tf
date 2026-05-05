variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "ap-northeast-1"
}

variable "project_name" {
  description = "Project name prefix"
  type        = string
  default     = "start-stop"
}

# Slack設定
variable "slack_bot_token" {
  description = "Slack Bot Token (xoxb-...)"
  type        = string
  sensitive   = true
}

variable "slack_signing_secret" {
  description = "Slack Signing Secret"
  type        = string
  sensitive   = true
}

variable "slack_channel_id" {
  description = "Slack channel ID for notifications"
  type        = string
}

# Outlook設定
variable "outlook_tenant_id" {
  description = "Microsoft Entra (Azure AD) Tenant ID"
  type        = string
  default     = ""
}

variable "outlook_client_id" {
  description = "Microsoft Entra App Client ID"
  type        = string
  default     = ""
}

variable "outlook_client_secret" {
  description = "Microsoft Entra App Client Secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "outlook_calendar_email" {
  description = "Outlook calendar email address to read events from"
  type        = string
  default     = ""
}

# staging/prod 環境のリソースID（本番運用時は tfvars で上書き）
variable "staging_ec2_instance_ids" {
  description = "staging環境のEC2インスタンスID（カンマ区切り）"
  type        = string
  default     = "placeholder"
}

variable "staging_rds_instance_id" {
  description = "staging環境のRDSインスタンスID"
  type        = string
  default     = "placeholder"
}

variable "prod_ec2_instance_ids" {
  description = "prod環境のEC2インスタンスID（カンマ区切り）"
  type        = string
  default     = "placeholder"
}

variable "prod_rds_instance_id" {
  description = "prod環境のRDSインスタンスID"
  type        = string
  default     = "placeholder"
}

# デモ用EC2/RDS設定
variable "ec2_ami_id" {
  description = "AMI ID for demo EC2 instance"
  type        = string
  default     = "ami-0d52744d6551d851e" # Amazon Linux 2023 ap-northeast-1
}

variable "ec2_instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.micro"
}

variable "rds_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.micro"
}

variable "rds_master_username" {
  description = "RDS master username"
  type        = string
  default     = "admin"
}

variable "rds_master_password" {
  description = "RDS master password"
  type        = string
  sensitive   = true
}
