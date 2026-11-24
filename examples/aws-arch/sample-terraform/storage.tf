resource "aws_sqs_queue" "order_events" {
  name       = "order-events.fifo"
  fifo_queue = true
}

resource "aws_rds_cluster" "aurora_main" {
  cluster_identifier     = "orders-aurora-pg"
  engine                 = "aurora-postgresql"
  database_name          = "orders_db"
  vpc_security_group_ids = [aws_security_group.rds_sg.id]
}

resource "aws_dynamodb_table" "cart_sessions" {
  name         = "cart-sessions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "session_id"
}

resource "aws_s3_bucket" "receipts" {
  bucket = "company-order-receipts"
}
