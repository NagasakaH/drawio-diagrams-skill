# どの環境のキューを指すか決まらない参照（同名が env/dev と env/prod に在る）。
# 推測で線を引かず、警告だけを出すことを確認するための材料。
resource "aws_lambda_function" "notifier" {
  function_name = "orders-notifier"
  runtime       = "nodejs20.x"

  environment {
    variables = {
      QUEUE_URL = aws_sqs_queue.orders_queue.url
    }
  }
}

# ルート `.` と env/dev に同じ `aws_dynamodb_table.sessions` があるケース。
# スキャン順に関係なく両者は必ず別の一意 ID を得ることを確認するための材料。
resource "aws_dynamodb_table" "sessions" {
  name = "sessions-root"
}
