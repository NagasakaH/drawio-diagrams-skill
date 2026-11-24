# prod 環境。dev と同じ `aws_lambda_function.api` / `aws_sqs_queue.orders_queue` が在る。
resource "aws_lambda_function" "api" {
  function_name = "orders-api-prod"
  runtime       = "nodejs20.x"

  environment {
    variables = {
      EVENTS_URL = aws_sqs_queue.orders_queue.url
      AUDIT_NAME = aws_dynamodb_table.audit.name
    }
  }
}

resource "aws_sqs_queue" "orders_queue" {
  name = "orders-prod"
}

resource "aws_dynamodb_table" "audit" {
  name = "audit-prod"
}

resource "aws_sfn_state_machine" "orchestrator" {
  name = "orders-sfn-prod"

  definition = jsonencode({
    Comment = "prod orchestration"
    States = {
      Pay = {
        Type     = "Task"
        Resource = aws_lambda_function.worker.arn
      }
      # Pass ステートの Result に ARN が現れても実行の根拠ではない（結んではいけない）
      Mock = {
        Type   = "Pass"
        Result = aws_lambda_function.mailer.arn
        End    = true
      }
    }
  })
}

resource "aws_lambda_function" "mailer" {
  function_name = "orders-mailer-prod"
  runtime       = "nodejs20.x"
}

resource "aws_lambda_function" "worker" {
  function_name = "orders-worker-prod"
  runtime       = "nodejs20.x"
}
