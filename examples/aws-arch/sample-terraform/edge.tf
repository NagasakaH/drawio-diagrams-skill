resource "aws_apigatewayv2_api" "orders_http_api" {
  name          = "orders-http-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "orders_api_lambda" {
  api_id             = aws_apigatewayv2_api.orders_http_api.id
  integration_type   = "AWS_PROXY"
  integration_uri    = aws_lambda_function.order_api.invoke_arn
}

resource "aws_cloudwatch_event_rule" "daily_reconcile" {
  name                = "daily-reconcile-rule"
  schedule_expression = "cron(0 2 * * ? *)"
}

resource "aws_cloudwatch_event_target" "reconcile_sfn" {
  rule = aws_cloudwatch_event_rule.daily_reconcile.name
  arn  = aws_sfn_state_machine.order_orchestrator.arn
}
