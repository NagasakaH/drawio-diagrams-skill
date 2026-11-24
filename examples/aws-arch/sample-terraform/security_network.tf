# These security / network / IAM / observability resources are OMITTED by default
# and only rendered when explicitly requested via `--include security,network,iam,observability`.

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_subnet" "private_a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}

resource "aws_security_group" "lambda_sg" {
  name        = "lambda-sg"
  description = "Outbound HTTPS & RDS 5432"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "rds_sg" {
  name        = "rds-sg"
  description = "Allow 5432 from lambda-sg"
  vpc_id      = aws_vpc.main.id
}

resource "aws_iam_role" "lambda_exec" {
  name = "lambda-exec-role"
}

resource "aws_iam_role" "sfn_exec" {
  name = "sfn-exec-role"
}

resource "aws_cloudwatch_log_group" "order_api_logs" {
  name = "/aws/lambda/order-api-handler"
}
