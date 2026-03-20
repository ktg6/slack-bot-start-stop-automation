# ---------- Step Functions State Machine ----------
resource "aws_sfn_state_machine" "main" {
  name     = "${var.project_name}-state-machine"
  role_arn = aws_iam_role.sfn.arn

  definition = templatefile("${path.module}/../step-functions/definition.asl.json", {
    ResourceOperatorArn = aws_lambda_function.resource_operator.arn
  })
}
