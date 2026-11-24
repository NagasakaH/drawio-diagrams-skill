resource "aws_lambda_function" "order_api" {
  function_name = "order-api-handler"
  runtime       = "nodejs22.x"
  handler       = "index.handler"
  role          = aws_iam_role.lambda_exec.arn

  vpc_config {
    subnet_ids         = [aws_subnet.private_a.id]
    security_group_ids = [aws_security_group.lambda_sg.id]
  }

  environment {
    variables = {
      DB_ENDPOINT    = aws_rds_cluster.aurora_main.endpoint
      DYNAMO_TABLE   = aws_dynamodb_table.cart_sessions.name
      ORDER_QUEUE    = aws_sqs_queue.order_events.url
      SFN_ARN        = aws_sfn_state_machine.order_orchestrator.arn
    }
  }
}

resource "aws_sfn_state_machine" "order_orchestrator" {
  name     = "order-workflow-sfn"
  type     = "STANDARD"
  role_arn = aws_iam_role.sfn_exec.arn

  definition = jsonencode({
    StartAt = "ProcessPayment"
    States = {
      ProcessPayment = {
        Type     = "Task"
        Resource = aws_lambda_function.payment_worker.arn
        Next     = "SaveReceipt"
      }
      SaveReceipt = {
        Type     = "Task"
        Resource = aws_dynamodb_table.cart_sessions.arn
        End      = true
      }
    }
  })
}

resource "aws_lambda_function" "payment_worker" {
  function_name = "payment-worker"
  runtime       = "nodejs22.x"
  handler       = "worker.handler"
  role          = aws_iam_role.lambda_exec.arn

  vpc_config {
    subnet_ids         = [aws_subnet.private_a.id]
    security_group_ids = [aws_security_group.lambda_sg.id]
  }

  environment {
    variables = {
      DB_ENDPOINT    = aws_rds_cluster.aurora_main.endpoint
      RECEIPT_BUCKET = aws_s3_bucket.receipts.id
    }
  }
}

resource "aws_lambda_event_source_mapping" "sqs_to_worker" {
  event_source_arn = aws_sqs_queue.order_events.arn
  function_name    = aws_lambda_function.payment_worker.arn
}
