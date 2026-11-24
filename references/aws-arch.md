> 統合スキル `drawio-diagrams-skill` のうち **Terraform → AWS アーキテクチャ構成図** を担当するリファレンス。
> 実行はすべて `node scripts/drawio-cli.mjs aws-arch ...` / `node scripts/scan-terraform.mjs ...` 経由。

# Terraform → AWS 構成図生成スキル (`drawio-aws-arch`)

Terraform (`.tf`) ファイル群を Pure Node.js スキャナで静的解析し、**実処理・データ保持を伴う AWS リソース**（API Gateway / Lambda / Step Functions / ECS / SQS / SNS / EventBridge / Aurora・RDS / DynamoDB / S3 等）とそれらの接続関係を抽出し、公式 AWS4 アイコンを用いた `.drawio` XML および `.drawio.png`（元XML埋め込み済み・draw.io再編集可能）を生成する。

---

## デフォルトの抽出方針とオプション層

- **デフォルトで描画する層（実処理・データ保持）**:
  - **Edge / API / Trigger**: `CloudFront`, `API Gateway`, `ALB`, `Cognito`, `EventBridge`
  - **Compute & Orchestration**: `Lambda`, `Step Functions (SFN)`, `ECS`, `EKS`, `EC2`, `AWS Batch`
  - **Messaging / Events**: `SQS`, `SNS`, `Kinesis`, `Firehose`
  - **Data & Storage**: `Aurora / RDS`, `DynamoDB`, `S3`, `ElastiCache`, `EFS`, `OpenSearch`
- **デフォルトでは省略する層（明示指定時のみ `--include` で追加）**:
  - `security`: `aws_security_group`, `aws_wafv2_web_acl`, `aws_kms_key`, `aws_secretsmanager_secret`
  - `network`: `aws_vpc`, `aws_subnet`, `aws_nat_gateway`, `aws_internet_gateway`, `aws_vpc_endpoint`
  - `iam`: `aws_iam_role`, `aws_iam_policy`
  - `observability`: `aws_cloudwatch_log_group`, `aws_cloudwatch_metric_alarm`
- ※ `aws_apigatewayv2_integration`・`aws_lambda_event_source_mapping`・`aws_s3_bucket_notification`・`aws_sns_topic_subscription`・`aws_cloudwatch_event_target` などの接続定義リソースは、箱としては描画せず**リソース間の矢印（エッジ）推論に自動利用**される。

---

## 実行手順

### 1. 抽出スコープの確認（任意・必要時）
- ユーザーが「Security Group や VPC も含めて」と指定している場合は `--include security` や `--include security,network` を付ける。
- 指定がない場合はデフォルト（実処理・データ層のみ、SecurityGroup・IAM等は省略）で実行する。

### 2. Terraform 解析 → `.drawio` + `.drawio.png` 一括生成（最短1コマンド）

```bash
# デフォルト（API / Lambda / SFN / SQS / RDS / DynamoDB / S3 のみ描画、SG等は省略）
node scripts/drawio-cli.mjs aws-arch \
  --tf-dir /path/to/terraform \
  --output /path/to/aws-arch.drawio.png \
  --xml-out /path/to/aws-arch.drawio \
  --json-out /path/to/aws-arch.json

# Security Group や VPC も含めて描画する場合
node scripts/drawio-cli.mjs aws-arch \
  --tf-dir /path/to/terraform \
  --include security \
  --output /path/to/aws-arch-with-sg.drawio.png
```

### 3. JSON 仕様を手動/LLMで補完してから描画する（2ステップ方式）

Terraform の `module` 呼び出しやアプリコード側の環境変数など、静的スキャンだけでは拾いきれない接続がある場合は、`--json-out` で出力した JSON を編集して `--spec` で再描画できる。

```bash
node scripts/scan-terraform.mjs --tf-dir /path/to/terraform -o /path/to/aws-arch.json
# （必要に応じて aws-arch.json の nodes / edges / label を補完・整理）
node scripts/drawio-cli.mjs aws-arch --spec /path/to/aws-arch.json -o /path/to/aws-arch.drawio.png
```

### 4. 目視検証（必須）
- 生成された `.drawio.png` を `read_file` で読み込み、アイコン・ラベル・矢印の重なりや省略状況を確認してからユーザーへ報告する。

---

## リファレンス

- 本ドキュメント末尾のリソースカタログ — 対応 Terraform `aws_*` リソース種別・デフォルト/オプション分類・AWS4 アイコン一覧

---

# resource-catalog.md — 対応 Terraform リソース分類とアイコン一覧

## 1. デフォルトで描画されるリソース（実処理・データ保持層）

| レイヤー | Terraform リソース型 | `kind` | draw.io AWS4 ステンシル |
|---|---|---|---|
| **Edge / API** | `aws_cloudfront_distribution` | `cloudfront` | `mxgraph.aws4.cloudfront` |
| **Edge / API** | `aws_apigatewayv2_api`, `aws_api_gateway_rest_api` | `apigw` | `mxgraph.aws4.api_gateway` |
| **Edge / API** | `aws_lb`, `aws_alb` | `alb` | `mxgraph.aws4.application_load_balancer` |
| **Edge / API** | `aws_cognito_user_pool` | `cognito` | `mxgraph.aws4.cognito` |
| **Edge / API** | `aws_cloudwatch_event_rule`, `aws_scheduler_schedule` | `eventbridge` | `mxgraph.aws4.eventbridge` |
| **Compute** | `aws_lambda_function` | `lambda` | `mxgraph.aws4.lambda` |
| **Compute** | `aws_sfn_state_machine` | `sfn` | `mxgraph.aws4.step_functions` |
| **Compute** | `aws_ecs_service`, `aws_batch_job_definition` | `ecs` | `mxgraph.aws4.ecs` |
| **Compute** | `aws_eks_cluster` | `eks` | `mxgraph.aws4.eks` |
| **Compute** | `aws_instance` | `ec2` | `mxgraph.aws4.ec2` |
| **Messaging** | `aws_sqs_queue` | `sqs` | `mxgraph.aws4.sqs` |
| **Messaging** | `aws_sns_topic` | `sns` | `mxgraph.aws4.sns` |
| **Messaging** | `aws_kinesis_stream` | `kinesis` | `mxgraph.aws4.kinesis` |
| **Messaging** | `aws_kinesis_firehose_delivery_stream` | `firehose` | `mxgraph.aws4.kinesis_data_firehose` |
| **Storage** | `aws_rds_cluster` | `aurora` | `mxgraph.aws4.aurora` |
| **Storage** | `aws_db_instance` | `rds` | `mxgraph.aws4.rds` |
| **Storage** | `aws_dynamodb_table` | `dynamodb` | `mxgraph.aws4.dynamodb` |
| **Storage** | `aws_s3_bucket` | `s3` | `mxgraph.aws4.s3` |
| **Storage** | `aws_elasticache_cluster`, `aws_elasticache_replication_group` | `elasticache` | `mxgraph.aws4.elasticache` |
| **Storage** | `aws_efs_file_system` | `efs` | `mxgraph.aws4.efs_standard` |
| **Storage** | `aws_opensearch_domain` | `opensearch` | `mxgraph.aws4.opensearch_service_data_node` |

## 2. デフォルト省略（`--include <category>` 指定時のみ描画）

| カテゴリ (`--include`) | Terraform リソース型 |
|---|---|
| `security` | `aws_security_group`, `aws_wafv2_web_acl`, `aws_kms_key`, `aws_secretsmanager_secret` |
| `network` | `aws_vpc`, `aws_subnet`, `aws_nat_gateway`, `aws_internet_gateway`, `aws_vpc_endpoint` |
| `iam` | `aws_iam_role`, `aws_iam_policy` |
| `observability` | `aws_cloudwatch_log_group`, `aws_cloudwatch_metric_alarm` |

## 3. 接続推論（エッジ自動生成）に利用する Glue リソース

以下は箱としては描画せず、リソース間の接続線（矢印）を自動生成するために解析します：
- `aws_apigatewayv2_integration`, `aws_api_gateway_integration` → `API Gateway` → `Lambda` / `SFN`
- `aws_lambda_event_source_mapping` → `SQS` / `DynamoDB` / `Kinesis` → `Lambda`
- `aws_s3_bucket_notification` → `S3` → `Lambda` / `SQS` / `SNS`
- `aws_sns_topic_subscription` → `SNS` → `SQS` / `Lambda`
- `aws_cloudwatch_event_target` → `EventBridge` → `Lambda` / `SFN` / `SQS`
- `aws_lb_listener`, `aws_lb_target_group` → `ALB` → `ECS` / `EC2` / `Lambda`
- さらに各リソースの `environment` や `definition`（Step Functions JSON 等）内の `aws_<type>.<name>` 参照から関係抽出します。

## 3.1 ディレクトリ（モジュール / 環境）をまたぐ同名リソース

`env/dev/main.tf` と `env/prod/main.tf` に同じ `aws_lambda_function.api` が在るのは通常どおりです。
スキャナはリソースを **`ディレクトリ + アドレス`** の組で識別する（`moduleKey::type.name`）ため、
環境違いで同じ箱が潰れて消えることはありません。

- ノード ID はディレクトリ違いだと `... __env_dev` / `... __env_prod` の接尾辞で分かれる
- 同じアドレスが複数ディレクトリに在るときは `warnings` に理由を列挙する（`--json-out` の JSON に同梱）
- 参照の解決は**同じディレクトリのリソースを優先**する。複数ディレクトリに同名が在ってどちらを指すか
  決まらない参照は、推測で線を引かず警告だけ出して省略する

## 3.2 エッジのラベルは「実行の証拠」があるものだけ

`Invoke` / `SendMessage` / `Trigger / Poll` / `Target` といった操作名のラベルは、次に該当する
**設定の証拠**がある線にだけ付けます。証拠が無い線を操作名で描くと、実際の動作と違う図になるためです。

| ラベル | 付く条件（証拠） | `edges[].type` |
|---|---|---|
| `Invoke` | API Gateway の integration、Step Functions の `definition` 内で `Type` が `Task` のステートの直下にある `Resource`、またはその `Parameters` の直下にある `FunctionName` が compute 層（Lambda / SFN / ECS など）を指す | `flow` |
| `Task` | 上の条件を満たす参照で、参照先が compute 層以外（SQS / SNS / DynamoDB など） | `flow` |
| `Trigger / Poll` | `aws_lambda_event_source_mapping` | `async` |
| `Target` | `aws_cloudwatch_event_target` / S3 notification / SNS subscription | `async` |
| `Origin` | CloudFront の `origin` / `*_cache_behavior` に書かれた参照 | `flow` |
| `references` | 環境変数や属性に `aws_x.y` を書いているだけで、実行設定の証拠が無い | `reference` |

Step Functions の `definition` は JSON キー（`"Resource": v`）と HCL のオブジェクト構文
（`Resource = v`）のどちらでも読めるよう、波括弧の深さとキーの階層を追って解析します。
`Parameters` の**直下**の `FunctionName` だけを実行の根拠にし、`Parameters.Payload` の中の
`FunctionName` や `Pass` ステートの `Result` に ARN を書いても `Invoke` / `Task` の線にはしません。
`Parallel` / `Map` の `Branches` / `Items` に入れ子にした Task はそのまま拾います。

`reference` は薄い灰色の点線（破線間隔 2 4）で描かれ、凡例にも `Static reference` として出ます。
実在する呼び出しなら JSON spec の `edges[].label` / `type` を `flow` / `async` に書き換えて確定させる。

---

