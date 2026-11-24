# dev 環境。prod と同じアドレス（aws_lambda_function.api）を持つが、
# 参照先は dev 自身のキューでなければならない。
resource "aws_lambda_function" "api" {
  function_name = "orders-api-dev"
  runtime       = "nodejs20.x"

  environment {
    variables = {
      EVENTS_URL = aws_sqs_queue.orders_queue.url
      TABLE_NAME = aws_dynamodb_table.sessions.name
      # prod 専用テーブルへの参照。dev 側に定義がないため結線してはいけない
      AUDIT_NAME = aws_dynamodb_table.audit.name
    }
  }
}

resource "aws_sqs_queue" "orders_queue" {
  name = "orders-dev"
}

resource "aws_dynamodb_table" "sessions" {
  name = "sessions-dev"
}

resource "aws_apigatewayv2_api" "http" {
  name          = "orders-http-dev"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "api_invoke" {
  api_id           = aws_apigatewayv2_api.http.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.api.invoke_arn
}
