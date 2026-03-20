# ---------- Lambda共通の実行ロール ----------
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ---------- slack-handler Lambda ロール ----------
resource "aws_iam_role" "slack_handler" {
  name               = "${var.project_name}-slack-handler-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "slack_handler" {
  # CloudWatch Logs
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:*:*:*"]
  }
  # Step Functions起動
  statement {
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.main.arn]
  }
  # SSM Parameter Store読み取り
  statement {
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${var.aws_region}:*:parameter/start-stop/*"]
  }
}

resource "aws_iam_role_policy" "slack_handler" {
  name   = "${var.project_name}-slack-handler-policy"
  role   = aws_iam_role.slack_handler.id
  policy = data.aws_iam_policy_document.slack_handler.json
}

# ---------- resource-operator Lambda ロール ----------
resource "aws_iam_role" "resource_operator" {
  name               = "${var.project_name}-resource-operator-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "resource_operator" {
  # CloudWatch Logs
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:*:*:*"]
  }
  # EC2 起動停止
  statement {
    actions   = ["ec2:StartInstances", "ec2:StopInstances", "ec2:DescribeInstances"]
    resources = ["*"]
  }
  # RDS 起動停止
  statement {
    actions   = ["rds:StartDBInstance", "rds:StopDBInstance", "rds:DescribeDBInstances"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "resource_operator" {
  name   = "${var.project_name}-resource-operator-policy"
  role   = aws_iam_role.resource_operator.id
  policy = data.aws_iam_policy_document.resource_operator.json
}

# ---------- outlook-sync Lambda ロール ----------
resource "aws_iam_role" "outlook_sync" {
  name               = "${var.project_name}-outlook-sync-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "outlook_sync" {
  # CloudWatch Logs
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:*:*:*"]
  }
  # EventBridgeルール管理
  statement {
    actions = [
      "events:PutRule", "events:DeleteRule",
      "events:PutTargets", "events:RemoveTargets",
      "events:ListRules", "events:ListTargetsByRule",
    ]
    resources = ["*"]
  }
  # Lambda権限管理（EventBridge→Lambda連携用）
  statement {
    actions   = ["lambda:AddPermission", "lambda:RemovePermission"]
    resources = ["*"]
  }
  # SSM Parameter Store読み取り
  statement {
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${var.aws_region}:*:parameter/start-stop/*"]
  }
}

resource "aws_iam_role_policy" "outlook_sync" {
  name   = "${var.project_name}-outlook-sync-policy"
  role   = aws_iam_role.outlook_sync.id
  policy = data.aws_iam_policy_document.outlook_sync.json
}

# ---------- Step Functions ロール ----------
data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "sfn" {
  name               = "${var.project_name}-sfn-role"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
}

data "aws_iam_policy_document" "sfn" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.resource_operator.arn]
  }
}

resource "aws_iam_role_policy" "sfn" {
  name   = "${var.project_name}-sfn-policy"
  role   = aws_iam_role.sfn.id
  policy = data.aws_iam_policy_document.sfn.json
}

# ---------- EventBridge→Step Functions トリガー用Lambdaロール ----------
resource "aws_iam_role" "sfn_trigger" {
  name               = "${var.project_name}-sfn-trigger-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "sfn_trigger" {
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:*:*:*"]
  }
  statement {
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.main.arn]
  }
}

resource "aws_iam_role_policy" "sfn_trigger" {
  name   = "${var.project_name}-sfn-trigger-policy"
  role   = aws_iam_role.sfn_trigger.id
  policy = data.aws_iam_policy_document.sfn_trigger.json
}
