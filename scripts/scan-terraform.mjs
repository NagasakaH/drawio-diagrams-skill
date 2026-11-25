#!/usr/bin/env node
/**
 * scan-terraform.mjs
 * Pure Node.js (.mjs) Terraform (.tf) scanner for AWS Architecture Diagram generation.
 *
 * By default, extracts active compute, API, orchestration, messaging, and data/storage
 * resources (API Gateway, CloudFront, ALB, Lambda, Step Functions, ECS, EKS, EC2,
 * SQS, SNS, EventBridge, Kinesis, RDS/Aurora, DynamoDB, S3, ElastiCache, EFS, OpenSearch)
 * and automatically infers connections from integrations, event source mappings,
 * S3/SNS/EventBridge targets, Step Functions definitions, and HCL attribute references.
 *
 * Security Groups, IAM roles/policies, VPC plumbing (route tables, NAT, subnets),
 * and CloudWatch log groups/alarms are OMITTED by default unless explicitly requested
 * via `--include security,network,iam,observability`.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  assertOutputsDistinctFromInputs,
  isDirectRun,
  resolveWriteTarget,
  writeFileAtomic,
} from "./diagram-shared.mjs";

/**
 * Resource classification catalog:
 * - layer: "edge" | "compute" | "messaging" | "storage" | "security" | "network" | "iam" | "observability"
 * - defaultIncluded: true for real processing / data holding layers, false for SG / IAM / network plumbing
 */
export const AWS_RESOURCE_CATALOG = {
  // === Edge / Entry (default included) ===
  aws_cloudfront_distribution: { layer: "edge", kind: "cloudfront", label: "CloudFront", defaultIncluded: true },
  aws_apigatewayv2_api: { layer: "edge", kind: "apigw", label: "API Gateway (HTTP/WS)", defaultIncluded: true },
  aws_api_gateway_rest_api: { layer: "edge", kind: "apigw", label: "API Gateway (REST)", defaultIncluded: true },
  aws_lb: { layer: "edge", kind: "alb", label: "ALB / NLB", defaultIncluded: true },
  aws_alb: { layer: "edge", kind: "alb", label: "Application Load Balancer", defaultIncluded: true },
  aws_appsync_graphql_api: { layer: "edge", kind: "apigw", label: "AppSync GraphQL", defaultIncluded: true },
  aws_cognito_user_pool: { layer: "edge", kind: "cognito", label: "Cognito User Pool", defaultIncluded: true },
  aws_cloudwatch_event_rule: { layer: "edge", kind: "eventbridge", label: "EventBridge Rule", defaultIncluded: true },
  aws_scheduler_schedule: { layer: "edge", kind: "eventbridge", label: "EventBridge Scheduler", defaultIncluded: true },

  // === Compute & Orchestration (default included) ===
  aws_lambda_function: { layer: "compute", kind: "lambda", label: "AWS Lambda", defaultIncluded: true },
  aws_sfn_state_machine: { layer: "compute", kind: "sfn", label: "Step Functions", defaultIncluded: true },
  aws_ecs_service: { layer: "compute", kind: "ecs", label: "ECS Service", defaultIncluded: true },
  aws_ecs_cluster: { layer: "compute", kind: "ecs", label: "ECS Cluster", defaultIncluded: false, category: "cluster" },
  aws_eks_cluster: { layer: "compute", kind: "eks", label: "EKS Cluster", defaultIncluded: true },
  aws_instance: { layer: "compute", kind: "ec2", label: "EC2 Instance", defaultIncluded: true },
  aws_batch_job_definition: { layer: "compute", kind: "ecs", label: "AWS Batch Job", defaultIncluded: true },

  // === Messaging & Streaming (default included) ===
  aws_sqs_queue: { layer: "messaging", kind: "sqs", label: "Amazon SQS", defaultIncluded: true },
  aws_sns_topic: { layer: "messaging", kind: "sns", label: "Amazon SNS", defaultIncluded: true },
  aws_kinesis_stream: { layer: "messaging", kind: "kinesis", label: "Kinesis Data Stream", defaultIncluded: true },
  aws_kinesis_firehose_delivery_stream: { layer: "messaging", kind: "firehose", label: "Kinesis Firehose", defaultIncluded: true },

  // === Data & Storage (default included) ===
  aws_rds_cluster: { layer: "storage", kind: "aurora", label: "Amazon Aurora", defaultIncluded: true },
  aws_db_instance: { layer: "storage", kind: "rds", label: "Amazon RDS", defaultIncluded: true },
  aws_dynamodb_table: { layer: "storage", kind: "dynamodb", label: "Amazon DynamoDB", defaultIncluded: true },
  aws_s3_bucket: { layer: "storage", kind: "s3", label: "Amazon S3", defaultIncluded: true },
  aws_elasticache_cluster: { layer: "storage", kind: "elasticache", label: "ElastiCache", defaultIncluded: true },
  aws_elasticache_replication_group: { layer: "storage", kind: "elasticache", label: "ElastiCache Redis", defaultIncluded: true },
  aws_efs_file_system: { layer: "storage", kind: "efs", label: "Amazon EFS", defaultIncluded: true },
  aws_opensearch_domain: { layer: "storage", kind: "opensearch", label: "OpenSearch", defaultIncluded: true },
  aws_elasticsearch_domain: { layer: "storage", kind: "opensearch", label: "OpenSearch", defaultIncluded: true },

  // === Security (OMITTED by default; include with --include security) ===
  aws_security_group: { layer: "security", kind: "sg", label: "Security Group", defaultIncluded: false, category: "security" },
  aws_wafv2_web_acl: { layer: "security", kind: "waf", label: "AWS WAF", defaultIncluded: false, category: "security" },
  aws_kms_key: { layer: "security", kind: "kms", label: "AWS KMS", defaultIncluded: false, category: "security" },
  aws_secretsmanager_secret: { layer: "security", kind: "secrets", label: "Secrets Manager", defaultIncluded: false, category: "security" },

  // === Network Plumbing (OMITTED by default; include with --include network) ===
  aws_vpc: { layer: "network", kind: "vpc", label: "Amazon VPC", defaultIncluded: false, category: "network" },
  aws_subnet: { layer: "network", kind: "subnet", label: "Subnet", defaultIncluded: false, category: "network" },
  aws_nat_gateway: { layer: "network", kind: "nat", label: "NAT Gateway", defaultIncluded: false, category: "network" },
  aws_internet_gateway: { layer: "network", kind: "igw", label: "Internet Gateway", defaultIncluded: false, category: "network" },
  aws_vpc_endpoint: { layer: "network", kind: "vpce", label: "VPC Endpoint", defaultIncluded: false, category: "network" },

  // === IAM (OMITTED by default; include with --include iam) ===
  aws_iam_role: { layer: "iam", kind: "iam", label: "IAM Role", defaultIncluded: false, category: "iam" },
  aws_iam_policy: { layer: "iam", kind: "iam", label: "IAM Policy", defaultIncluded: false, category: "iam" },

  // === Observability (OMITTED by default; include with --include observability) ===
  aws_cloudwatch_log_group: { layer: "observability", kind: "cloudwatch", label: "CloudWatch Logs", defaultIncluded: false, category: "observability" },
  aws_cloudwatch_metric_alarm: { layer: "observability", kind: "cloudwatch", label: "CloudWatch Alarm", defaultIncluded: false, category: "observability" },
};

const GLUE_RESOURCE_TYPES = new Set([
  "aws_api_gateway_integration",
  "aws_apigatewayv2_integration",
  "aws_apigatewayv2_route",
  "aws_lambda_event_source_mapping",
  "aws_s3_bucket_notification",
  "aws_sns_topic_subscription",
  "aws_cloudwatch_event_target",
  "aws_lb_target_group",
  "aws_lb_listener",
  "aws_lb_listener_rule",
]);

/**
 * Recursively collects all `.tf` files under `rootDir`, skipping `.terraform`, `node_modules`, `.git`.
 *
 * 出力先の上書き防止検査（assertOutputsDistinctFromInputs）に渡す一覧もこの関数が
 * 返す一覧を使う — 別の簡易走査で「入力に無い」と誤判定する事故を防ぐ。
 */
export async function collectTerraformFiles(rootDir) {
  const results = [];
  const skipDirs = new Set([".terraform", "node_modules", ".git", "dist", "out"]);

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (!skipDirs.has(ent.name)) {
          await walk(path.join(dir, ent.name));
        }
      } else if (ent.isFile() && ent.name.endsWith(".tf")) {
        results.push(path.join(dir, ent.name));
      }
    }
  }

  await walk(rootDir);
  results.sort();
  return results;
}

/**
 * Strips HCL comments (#..., //..., /* ... *\/) while preserving quoted strings.
 */
function stripHclComments(src) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
    } else if (ch === "#") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * Extracts top-level `resource "<type>" "<name>" { ... }` blocks from a `.tf` file.
 */
function parseTerraformBlocks(content, filePath) {
  const clean = stripHclComments(content);
  const blocks = [];
  const headerRe = /\b(resource|data|module)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{/g;

  let m;
  while ((m = headerRe.exec(clean)) !== null) {
    const blockKind = m[1];
    const typeOrName = m[2];
    const resName = m[3] || "";
    let depth = 1;
    let pos = headerRe.lastIndex;
    let inStr = false;

    while (pos < clean.length && depth > 0) {
      const ch = clean[pos];
      if (inStr) {
        if (ch === "\\" && pos + 1 < clean.length) {
          pos += 2;
          continue;
        }
        if (ch === '"') inStr = false;
      } else {
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      pos++;
    }

    const body = clean.slice(headerRe.lastIndex, pos - 1);
    blocks.push({
      blockKind,
      type: blockKind === "module" ? "module" : typeOrName,
      name: blockKind === "module" ? typeOrName : resName,
      body,
      filePath,
    });
    headerRe.lastIndex = pos;
  }

  return blocks;
}

function extractStringAttr(body, keys) {
  for (const k of keys) {
    const re = new RegExp(`\\b${k}\\s*=\\s*"([^"]+)"`);
    const m = body.match(re);
    if (m) return m[1];
  }
  return null;
}

function extractResourceReferences(body) {
  const refs = new Set();
  const re = /\b(aws_[a-z0-9_]+)\.([a-zA-Z0-9_-]+)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    refs.add(`${m[1]}.${m[2]}`);
  }
  return [...refs];
}

/**
 * 明示的な `depends_on = [...]` を本文から取り除く。
 *
 * `depends_on` は「作成順序の宣言」であって実行の接続ではない。これを参照抽出に
 * 残すと、`aws_apigatewayv2_integration` に `depends_on = [aws_lambda_function.mailer]`
 * と書いただけで mailer への Invoke 線が生まれてしまう。
 * 文字列リテラルと入れ子配列を壊さずに、対応する `]` までを空白へ置き換える
 * （改行はそのまま残るので他の属性の位置は動かない）。
 */
function stripDependsOn(body) {
  const text = String(body || "");
  if (!/\bdepends_on\s*=/.test(text)) return text;
  const re = /\bdepends_on\s*=\s*\[/g;
  let out = "";
  let cursor = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    let i = re.lastIndex - 1; // 開き `[`
    let depth = 0;
    let inStr = false;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (inStr) {
        if (ch === "\\") {
          i += 1;
          continue;
        }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "[") depth += 1;
      else if (ch === "]") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const end = i < text.length ? i + 1 : text.length; // 閉じ `]` の次
    out += text.slice(cursor, m.index) + " ";
    cursor = end;
    re.lastIndex = end;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * 接続の根拠となる参照アドレスを本文から集める（`depends_on` は根拠にしない）。
 * 参照抽出をするときは必ずこの関数を通すこと。
 */
function extractConnectionReferences(body) {
  return extractResourceReferences(stripDependsOn(body));
}

/**
 * 指定した属性名（`api_id` / `integration_uri` / `event_source_arn` など）の
 * 値に現れる `aws_type.name` アドレスだけを集める。glue リソースの接続先を
 * 「属性名の意味」で決めるために使う。
 * @param {string} body
 * @param {string[]} attrNames
 * @param {{ topLevelOnly?: boolean }} [opts] `true` のときはトップレベル（波括弧深さ 0）の属性だけを見る
 */
function extractAttributeReferences(body, attrNames, { topLevelOnly = false } = {}) {
  const addrs = new Set();
  const text = String(body || "");
  const attrSet = new Set(attrNames || []);
  if (attrSet.size === 0) return [];

  const n = text.length;
  let depth = 0;
  let i = 0;

  const skipHclString = (from) => {
    let p = from + 1;
    while (p < n) {
      const ch = text[p];
      if (ch === "\\") {
        p += 2;
        continue;
      }
      if (ch === "$" && text[p + 1] === "{") {
        let interpDepth = 0;
        while (p < n) {
          if (text[p] === '"') {
            p = skipHclString(p);
            continue;
          }
          if (text[p] === "{") interpDepth += 1;
          else if (text[p] === "}") {
            interpDepth -= 1;
            if (interpDepth === 0) {
              p += 1;
              break;
            }
          }
          p += 1;
        }
        continue;
      }
      if (ch === '"') return p + 1;
      p += 1;
    }
    return n;
  };

  const readExprEnd = (from) => {
    let p = from;
    while (p < n && (text[p] === " " || text[p] === "\t")) p += 1;
    let exprDepth = 0;
    while (p < n) {
      const ch = text[p];
      if (ch === '"') {
        p = skipHclString(p);
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        exprDepth += 1;
        p += 1;
        continue;
      }
      if (ch === ")" || ch === "]" || ch === "}") {
        if (exprDepth > 0) exprDepth -= 1;
        p += 1;
        continue;
      }
      if (ch === "\n" && exprDepth === 0) break;
      p += 1;
    }
    return p;
  };

  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      i = skipHclString(i);
      continue;
    }
    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) depth -= 1;
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch) && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]))) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(text[j])) j += 1;
      const ident = text.slice(i, j);
      let k = j;
      while (k < n && (text[k] === " " || text[k] === "\t")) k += 1;
      if (text[k] === "=" && text[k + 1] !== "=" && attrSet.has(ident) && (!topLevelOnly || depth === 0)) {
        const exprEnd = readExprEnd(k + 1);
        for (const addr of extractResourceReferences(text.slice(k + 1, exprEnd))) {
          addrs.add(addr);
        }
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return [...addrs];
}

/**
 * glue リソース（integration / event source mapping / target / subscription など）の
 * 接続規則。「どちらの属性が起点で、どちらの属性が接続先か」を属性名で持つ。
 *
 *   sourceAttrs → 図の始点側（API Gateway / イベントソース / ルール / トピック / ALB）
 *   targetAttrs → 図の終点側（Lambda / SQS / SNS / ターゲットグループ）
 *
 * 接続は「起点・終点ともに属性名で解決できたもの」だけを根拠にする。
 * 未解決時に本文全体（redrive_policy / dead_letter_config など）へフォールバックしない。
 */
const GLUE_CONNECT_RULES = {
  aws_apigatewayv2_integration: {
    sourceAttrs: ["api_id", "rest_api_id"],
    targetAttrs: ["integration_uri"],
    sourceKinds: ["apigw"],
    label: "Invoke",
    edgeType: "flow",
  },
  aws_api_gateway_integration: {
    sourceAttrs: ["rest_api_id", "api_id"],
    targetAttrs: ["integration_uri", "uri"],
    sourceKinds: ["apigw"],
    label: "Invoke",
    edgeType: "flow",
  },
  aws_lambda_event_source_mapping: {
    sourceAttrs: ["event_source_arn", "self_managed_event_source"],
    targetAttrs: ["function_name"],
    targetKinds: ["lambda"],
    label: "Trigger / Poll",
    edgeType: "async",
  },
  aws_cloudwatch_event_target: {
    sourceAttrs: ["rule"],
    targetAttrs: ["arn"],
    topLevelTarget: true,
    sourceKinds: ["eventbridge"],
    label: "Target",
    edgeType: "async",
  },
  aws_sns_topic_subscription: {
    sourceAttrs: ["topic_arn"],
    targetAttrs: ["endpoint"],
    topLevelSource: true,
    topLevelTarget: true,
    sourceKinds: ["sns"],
    label: "Subscribe",
    edgeType: "async",
  },
  aws_s3_bucket_notification: {
    sourceAttrs: ["bucket"],
    targetAttrs: ["lambda_function_arn", "queue_arn", "topic_arn"],
    sourceKinds: ["s3"],
    label: "S3 Event",
    edgeType: "async",
  },
  aws_lb_listener: {
    sourceAttrs: ["load_balancer_arn"],
    targetAttrs: ["target_group_arn"],
    sourceKinds: ["alb"],
    label: "Forward",
    edgeType: "flow",
  },
  aws_lb_listener_rule: {
    sourceAttrs: ["load_balancer_arn"],
    targetAttrs: ["target_group_arn"],
    sourceKinds: ["alb"],
    label: "Forward",
    edgeType: "flow",
  },
  aws_lb_target_group: {
    sourceAttrs: ["load_balancer_arn"],
    targetAttrs: ["target_group_arn"],
    sourceKinds: ["alb"],
    label: "Forward",
    edgeType: "flow",
  },
};

function buildResourceSubtitle(type, name, body) {
  const details = [];
  if (type === "aws_lambda_function") {
    const rt = extractStringAttr(body, ["runtime"]);
    const fn = extractStringAttr(body, ["function_name"]);
    if (fn && fn !== name) details.push(fn);
    if (rt) details.push(rt);
  } else if (type === "aws_rds_cluster" || type === "aws_db_instance") {
    const eng = extractStringAttr(body, ["engine"]);
    const db = extractStringAttr(body, ["database_name", "db_name", "identifier", "cluster_identifier"]);
    if (eng) details.push(eng);
    if (db) details.push(db);
  } else if (type === "aws_dynamodb_table") {
    const hk = extractStringAttr(body, ["hash_key"]);
    const rk = extractStringAttr(body, ["range_key"]);
    if (hk) details.push(rk ? `PK: ${hk} / SK: ${rk}` : `PK: ${hk}`);
  } else if (type === "aws_s3_bucket") {
    const bk = extractStringAttr(body, ["bucket", "bucket_prefix"]);
    if (bk) details.push(bk);
  } else if (type === "aws_apigatewayv2_api" || type === "aws_api_gateway_rest_api") {
    const proto = extractStringAttr(body, ["protocol_type"]);
    const apiName = extractStringAttr(body, ["name"]);
    if (apiName && apiName !== name) details.push(apiName);
    if (proto) details.push(proto);
  } else if (type === "aws_sfn_state_machine") {
    const sfnType = extractStringAttr(body, ["type"]);
    const sfnName = extractStringAttr(body, ["name"]);
    if (sfnName && sfnName !== name) details.push(sfnName);
    if (sfnType) details.push(sfnType);
  } else if (type === "aws_sqs_queue" || type === "aws_sns_topic") {
    const qName = extractStringAttr(body, ["name"]);
    if (qName && qName !== name) details.push(qName);
    if (/\bfifo_queue\s*=\s*true\b/.test(body)) details.push("FIFO");
  } else if (type === "aws_security_group") {
    const desc = extractStringAttr(body, ["description", "name"]);
    if (desc) details.push(desc);
  } else if (type === "aws_vpc") {
    const cidr = extractStringAttr(body, ["cidr_block"]);
    if (cidr) details.push(cidr);
  } else if (type === "aws_elasticache_cluster" || type === "aws_elasticache_replication_group") {
    const eng = extractStringAttr(body, ["engine"]);
    if (eng) details.push(eng);
  } else if (type === "aws_ecs_service") {
    const lt = extractStringAttr(body, ["launch_type"]);
    if (lt) details.push(lt);
  } else if (type === "aws_cloudwatch_event_rule" || type === "aws_scheduler_schedule") {
    const sched = extractStringAttr(body, ["schedule_expression"]);
    if (sched) details.push(sched);
  }
  return details.join(" / ");
}

function makeDisplayName(type, tfName, body) {
  const explicitName = extractStringAttr(body, [
    "function_name",
    "cluster_identifier",
    "identifier",
    "bucket",
    "name",
  ]);
  // Avoid noisy Terraform interpolation strings like "${var.env}-orders"
  if (explicitName && !explicitName.includes("${") && explicitName.length <= 34) {
    return explicitName;
  }
  return tfName;
}

/**
 * `resource` ブロックの本体から特定セクション（`definition = jsonencode({...})` など）
 * の中身を抜き出す。運用の「根拠」となる箇所に参照が出ているかの判定に使う。
 */
function extractSectionBody(body, keys) {
  for (const k of keys) {
    const re = new RegExp(`\\b${k}\\s*=`, "");
    const m = re.exec(body);
    if (!m) continue;
    let i = body.indexOf("{", m.index);
    if (i < 0) continue;
    let depth = 0;
    for (let p = i; p < body.length; p += 1) {
      if (body[p] === "{") depth += 1;
      else if (body[p] === "}") {
        depth -= 1;
        if (depth === 0) return body.slice(i, p + 1);
      }
    }
  }
  return "";
}

/** 参照アドレスが本文の指定セクション内に現れるか（＝接続の根拠があるか）。 */
function refAppearsIn(section, addr) {
  if (!section) return false;
  const [type, name] = addr.split(".");
  if (!type || !name) return false;
  return new RegExp(`\\b${type}\\s*\\.\\s*${name}\\b`).test(section);
}

/**
 * ASL（State Machine Definition）を、波括弧の深さとキーの階層を追って読み解く
 * 最小パーサ。`{ ... }` / `[ ... ]` / 文字列リテラル（`\"` エスケープと
 * `${...}` 補間を壊さない）だけ分かればよく、読めない箇所で投げずに
 * その文字を飛ばして立ち直る（走査全体を止めない）。
 *
 * 返すノードは次の形の素朴なツリー:
 *   { kind: "object", keys: Map<キー名, ノード> }
 *   { kind: "array",  items: ノード[] }
 *   { kind: "string", text }  // 引用符の中身（エスケープはそのまま）
 *   { kind: "token",  text }  // 引用符なしの生トークン（HCL の `aws_x.arn` など）
 *
 * キーは JSON 表記（`"Resource": v`）と HCL のオブジェクト構文
 * （`Resource = v`）の両方を受け取る。
 */
const ASL_KEY_STOP = /[:=\s}\n]/;

function parseAslValue(text, pos) {
  const len = text.length;

  const skipSpace = (from) => {
    let p = from;
    while (p < len && /\s/.test(text[p])) p += 1;
    return p;
  };

  const readString = (from) => {
    // text[from] === '"'
    let p = from + 1;
    let out = "";
    while (p < len) {
      const c = text[p];
      if (c === "\\") {
        out += c + (text[p + 1] ?? "");
        p += 2;
        continue;
      }
      if (c === "$" && text[p + 1] === "{") {
        // 補間は閉じ波括弧まで素通し（中の引用符や波括弧で文字列を終わらせない）
        let depth = 0;
        let interp = "";
        while (p < len) {
          if (text[p] === "{") depth += 1;
          else if (text[p] === "}") {
            depth -= 1;
            if (depth === 0) {
              interp += "}";
              p += 1;
              break;
            }
          }
          interp += text[p];
          p += 1;
        }
        out += interp;
        continue;
      }
      if (c === '"') return { node: { kind: "string", text: out }, next: p + 1 };
      out += c;
      p += 1;
    }
    return { node: { kind: "string", text: out }, next: len };
  };

  const readToken = (from) => {
    let p = from;
    let out = "";
    while (p < len && !",}]".includes(text[p]) && text[p] !== "\n") {
      out += text[p];
      p += 1;
    }
    return { node: { kind: "token", text: out.trim() }, next: p };
  };

  const readObject = (from) => {
    // text[from] === '{'
    const keys = new Map();
    let p = from + 1;
    for (;;) {
      p = skipSpace(p);
      while (p < len && (text[p] === "," || text[p] === ";")) p = skipSpace(p + 1);
      if (p >= len) break;
      if (text[p] === "}") return { node: { kind: "object", keys }, next: p + 1 };

      // --- キー名（引用符つき / 生トークンの両形） ---
      let key = null;
      if (text[p] === '"') {
        const r = readString(p);
        key = r.node.text;
        p = skipSpace(r.next);
      } else {
        let q = p;
        while (q < len && !ASL_KEY_STOP.test(text[q])) q += 1;
        if (q === p) {
          p += 1; // 読めない文字は飛ばして立ち直る
          continue;
        }
        key = text.slice(p, q).trim();
        p = skipSpace(q);
      }
      if (p >= len) break;
      if (text[p] !== ":" && text[p] !== "=") continue; // キーだけで終わる行は無視
      p = skipSpace(p + 1);
      if (p >= len) break;
      if (text[p] === "," || text[p] === "}") continue; // 値が空の項目
      const value = parseAslValue(text, p);
      if (key) keys.set(key, value.node);
      p = value.next;
    }
    return { node: { kind: "object", keys }, next: len };
  };

  const readArray = (from) => {
    const items = [];
    let p = from + 1;
    for (;;) {
      p = skipSpace(p);
      if (p >= len) break;
      if (text[p] === "]") return { node: { kind: "array", items }, next: p + 1 };
      const before = p;
      const value = parseAslValue(text, p);
      items.push(value.node);
      p = value.next > before ? value.next : before + 1; // 進まなければ 1 文字飛ばす
    }
    return { node: { kind: "array", items }, next: len };
  };

  if (text[pos] === "{") return readObject(pos);
  if (text[pos] === "[") return readArray(pos);
  if (text[pos] === '"') return readString(pos);
  return readToken(pos);
}

/** パース済みノードについて、指定キーの「直接の子」ノードを取り出す。 */
function aslDirectChild(node, key) {
  if (!node || node.kind !== "object") return null;
  return node.keys.get(key) ?? null;
}

const SFN_LAMBDA_INVOKE_RESOURCE_RE =
  /^arn:aws(?:-[a-z0-9-]+)?:states:[^:]*:[^:]*:(?:aws-sdk:)?lambda:invoke(?:\.[A-Za-z0-9_-]+)?$/;

/**
 * ASL（State Machine Definition）から **「Type が Task のステート」にある
 * 実行先 Resource、および `lambda:invoke` / `aws-sdk:lambda:invoke` 系タスクの
 * Parameters.FunctionName / Arguments.FunctionName に現れる参照アドレスだけ**を収集する。
 *
 * 判定は `parseAslValue()` が作った階層ツリーに対して行う。
 *
 *   - `Type` が直接の子で、その値が `Task` のオブジェクトだけを対象にする
 *   - `Resource` はそのオブジェクトの直下（相対深さ 0）だけを見る
 *   - `FunctionName` は `Resource` が `lambda:invoke` / `aws-sdk:lambda:invoke` 系の場合のみ
 *     `Parameters` / `Arguments`（JSONata）の直下（相対深さ 1）を見る
 *     よって `aws-sdk:lambda:getFunction` や `Parameters.Payload.FunctionName` /
 *     `Arguments.Payload.FunctionName` は Invoke の根拠にならない
 *   - 再帰するのは状態機械の構造をたどるときだけ:
 *       `Parallel` → 直下 `Branches[]` の各要素
 *       `Map`      → 直下 `Iterator` / `ItemProcessor`（`ProcessorArn` も実行先）
 *
 * **`Pass` / `Choice` / `Wait` / `Succeed` / `Fail` の `Result`・`ResultPath`・
 * `Parameters`・`Arguments`・`Output`・`InputPath` は実行の根拠にならないので立ち入らない。**
 * かつてはオブジェクトの全ての子へ無条件に再帰していたため、`Pass` の
 * `Result` に Lambda ARN を書くだけで Invoke エッジが生まれていた。
 * JSON 表記（`"Type": "Task"`）と HCL jsonencode のオブ構文（`Type = "Task"`）
 * の両方に対応する。
 */
function extractSfnTaskRefAddrs(definitionSection) {
  const addrs = new Set();
  const text = String(definitionSection || "");
  if (!text) return addrs;

  const addFrom = (node) => {
    if (!node) return;
    if (node.kind === "string" || node.kind === "token") {
      for (const addr of extractResourceReferences(node.text ?? "")) addrs.add(addr);
    }
  };
  const directText = (node, key) => {
    const child = aslDirectChild(node, key);
    return child && (child.kind === "string" || child.kind === "token")
      ? child.text.trim()
      : "";
  };

  /** `States` を持つオブジェクト（定義本体・Parallel の分岐・Map のサブ状態機械）を歩く。 */
  const collectFromStateMachine = (node) => {
    if (!node || node.kind !== "object") return;
    const states = aslDirectChild(node, "States");
    if (states && states.kind === "object") {
      for (const stateNode of states.keys.values()) collectFromState(stateNode);
      return;
    }
    // `Branches` の要素のように、ノードそのものがステート定義の場合も受け取る
    if (directText(node, "Type")) collectFromState(node);
  };

  /** `States` の値 1 つ（ステート定義）を、Type に応じて構造に沿って見る。 */
  const collectFromState = (stateNode) => {
    if (!stateNode || stateNode.kind !== "object") return;
    const type = directText(stateNode, "Type");

    if (type === "Task") {
      const resourceNode = aslDirectChild(stateNode, "Resource");
      addFrom(resourceNode);
      const resourceText = directText(stateNode, "Resource");
      if (SFN_LAMBDA_INVOKE_RESOURCE_RE.test(resourceText)) {
        addFrom(aslDirectChild(aslDirectChild(stateNode, "Parameters"), "FunctionName"));
        addFrom(aslDirectChild(aslDirectChild(stateNode, "Arguments"), "FunctionName"));
      }
      return;
    }
    if (type === "Parallel") {
      const branches = aslDirectChild(stateNode, "Branches");
      if (branches && branches.kind === "array") {
        for (const branch of branches.items) collectFromStateMachine(branch);
      }
      return;
    }
    if (type === "Map") {
      collectFromStateMachine(aslDirectChild(stateNode, "Iterator"));
      const processor = aslDirectChild(stateNode, "ItemProcessor");
      if (processor) {
        collectFromStateMachine(processor);
        addFrom(aslDirectChild(processor, "ProcessorArn"));
      }
      return;
    }
    // Pass / Choice / Wait / Succeed / Fail — ここには立ち入らない
  };

  collectFromStateMachine(parseAslValue(text, 0).node);
  return addrs;
}

/**
 * Scans a directory of `.tf` files and produces an architecture specification object.
 *
 * 別モジュール・別環境の混在を防ぐため、リソースは
 * 「置かれたディレクトリ（モジュール / 環境）＋ Terraform アドレス」で識別する。
 * 同じディレクトリをまたいで同名アドレスがある場合、上書きせず別ノードにし、
 * `warnings` に診断を残す。参照解決もまず同一ディレクトリ内を優先する。
 */
export async function scanTerraformDirectory(
  tfDir,
  {
    includeCategories = [],
    title = null,
    subtitle = null,
    files = null,
    scannedInputFiles = null,
  } = {}
) {
  const includeSet = new Set(
    includeCategories.map((c) => String(c).trim().toLowerCase()).filter(Boolean)
  );
  const includeAll = includeSet.has("all");

  // `files` を渡すとその一覧をそのまま走査する（呼び出し側の上書き防止検査と
  // 同じ一覧を共有するため）。`scannedInputFiles` 配列には実走査一覧を詰め戻す。
  const tfFiles = files ? files.map((f) => path.resolve(f)) : await collectTerraformFiles(tfDir);
  if (Array.isArray(scannedInputFiles)) scannedInputFiles.push(...tfFiles);
  if (tfFiles.length === 0) {
    throw new Error(`No .tf files found under: ${tfDir}`);
  }

  /** ディレクトリ（モジュール / 環境）単位の識別子。ルートは "." */
  const moduleKeyOf = (fp) => {
    const rel = path.relative(tfDir, path.dirname(fp));
    const norm = rel.split(path.sep).join("/");
    return !norm || norm === "" ? "." : norm;
  };

  const allResources = new Map(); // key = "<moduleDir>::<aws_type.name>"
  const addrIndex = new Map(); // "<aws_type.name>" -> [key, ...]
  const glueBlocks = [];
  const omittedSummary = {};
  const warnings = [];
  const warnedAmbiguous = new Set();

  for (const fp of tfFiles) {
    const moduleKey = moduleKeyOf(fp);
    const relFile = path.relative(tfDir, fp).split(path.sep).join("/");
    const content = await fs.readFile(fp, "utf8");
    const blocks = parseTerraformBlocks(content, fp);
    for (const blk of blocks) {
      if (blk.blockKind !== "resource") continue;
      const addr = `${blk.type}.${blk.name}`;
      const key = `${moduleKey}::${addr}`;

      if (GLUE_RESOURCE_TYPES.has(blk.type)) {
        // refBody: depends_on を除いた本文。glue の接続先はこの本文から決める。
        const refBody = stripDependsOn(blk.body);
        glueBlocks.push({
          ...blk,
          addr,
          moduleKey,
          file: relFile,
          refBody,
          refs: extractResourceReferences(refBody),
        });
        continue;
      }

      const meta = AWS_RESOURCE_CATALOG[blk.type];
      if (!meta) {
        omittedSummary[blk.type] = (omittedSummary[blk.type] || 0) + 1;
        continue;
      }

      const isIncluded =
        meta.defaultIncluded ||
        includeAll ||
        (meta.category && includeSet.has(meta.category)) ||
        includeSet.has(blk.type) ||
        includeSet.has(meta.kind);

      if (!isIncluded) {
        omittedSummary[blk.type] = (omittedSummary[blk.type] || 0) + 1;
        continue;
      }

      if (allResources.has(key)) {
        warnings.push(
          `同一ディレクトリ ${moduleKey} に重複アドレス ${addr} (${relFile}) があります。` +
            `先頭の定義を使い、後の定義は図から除外します。`
        );
        continue;
      }

      // 別ディレクトリ（別モジュール / 別環境）に同名アドレスがある場合は別ノードにする。
      // ID の採番自体は走査順に依存しないよう、全リソース収集後の一括パスで行う。
      const others = addrIndex.get(addr) || [];
      if (others.length > 0) {
        const prevFiles = others
          .map((k) => allResources.get(k)?.file)
          .filter(Boolean)
          .join(", ");
        warnings.push(
          `別ディレクトリに同名リソース ${addr} が見つかりました (${prevFiles} と ${relFile})。` +
            `上書きせず ${blk.type}.${blk.name} (${moduleKey}) として別ノード扱いにします。` +
            `環境を分けて描くときは --tf-dir を各環境ディレクトリに向けてください。`
        );
      }

      const definitionSection =
        blk.type === "aws_sfn_state_machine"
          ? extractSectionBody(blk.body, ["definition_inline", "definition"])
          : "";
      const originSection =
        blk.type === "aws_cloudfront_distribution"
          ? extractSectionBody(blk.body, ["ordered_cache_behavior", "default_cache_behavior"]) ||
            (/\borigins\s*=/.test(blk.body) ? blk.body : "")
          : "";

      allResources.set(key, {
        id: "",
        tfAddress: addr,
        module: moduleKey,
        tfType: blk.type,
        tfName: blk.name,
        layer: meta.layer,
        kind: meta.kind,
        label: makeDisplayName(blk.type, blk.name, blk.body),
        serviceLabel: meta.label,
        subtitle: buildResourceSubtitle(blk.type, blk.name, blk.body),
        file: relFile,
        refs: extractConnectionReferences(blk.body),
        body: blk.body,
        _definitionSection: definitionSection,
        _originSection: originSection,
        _invokeRefAddrs:
          blk.type === "aws_sfn_state_machine" ? extractSfnTaskRefAddrs(definitionSection) : null,
      });
      if (!addrIndex.has(addr)) addrIndex.set(addr, []);
      addrIndex.get(addr).push(key);
    }
  }

  // ---------------------------------------------------------------------------
  // ID 採番（全リソース収集後・走査順非依存）:
  //   - 同じアドレスが 1 ディレクトリにしか無ければ素の ID
  //   - 複数ディレクトリにまたがるなら、ルート "." は素の ID、他ディレクトリは
  //     `__<ディレクトリ名>` サフィックスを付け、それでも衝突したら連番で避ける。
  //   global な usedIds で守るため、ルート `.` と `sub/` が同じ type.name を持つとき
  //   スキャン順に関係なく必ず別々の一意 ID になる。
  // ---------------------------------------------------------------------------
  const usedIds = new Set();
  const claimId = (candidate) => {
    let id = candidate;
    let i = 2;
    while (usedIds.has(id)) id = `${candidate}_${i++}`;
    usedIds.add(id);
    return id;
  };
  {
    const groupByAddr = new Map();
    for (const [key, res] of allResources) {
      if (!groupByAddr.has(res.tfAddress)) groupByAddr.set(res.tfAddress, []);
      groupByAddr.get(res.tfAddress).push(key);
    }
    const baseOf = (addr) => addr.replace(/[^a-zA-Z0-9_]/g, "_");
    for (const [addr, keys] of groupByAddr) {
      if (keys.length === 1) {
        allResources.get(keys[0]).id = claimId(baseOf(addr));
        continue;
      }
      for (const k of keys) {
        const res = allResources.get(k);
        const candidate =
          res.module === "."
            ? baseOf(addr)
            : `${baseOf(addr)}__${res.module.replace(/[^a-zA-Z0-9]+/g, "_")}`;
        res.id = claimId(candidate);
      }
    }
  }

  /**
   * 参照アドレス (`aws_type.name`) を解決する。
   *
   * 解決は**同一ディレクトリ内のみ**に厳格限定する。別ディレクトリ（別環境・
   * 別モジュール）の同名リソースを単一候補だからと自動採用すると、dev の
   * Lambda が prod 専用テーブルと結ばれてしまう。解決できない場合は
   * `warnings` に診断を残して結線しない。
   */
  const moduleKeyOfKey = (key) => key.split("::")[0];
  const resolveRef = (fromKey, refAddr) => {
    const fromDir = moduleKeyOfKey(fromKey);
    const sameDir = `${fromDir}::${refAddr}`;
    if (allResources.has(sameDir)) return sameDir;
    const candidates = addrIndex.get(refAddr) || [];
    if (candidates.length === 0) return null; // 図に含まれない種別（既定除外など）
    const warnKey = `${fromDir}|${refAddr}`;
    if (!warnedAmbiguous.has(warnKey)) {
      warnedAmbiguous.add(warnKey);
      const where = candidates.map((k) => allResources.get(k)?.file).filter(Boolean).join(", ");
      if (candidates.length === 1) {
        warnings.push(
          `参照 ${refAddr} はディレクトリ ${fromDir} 内に定義がないため接続線を結びません。` +
            `同名リソースは ${where} にありますが、環境をまたいだ結線は推測で行いません` +
            `（結線したい場合は --tf-dir を各環境ディレクトリに向けてください）。`
        );
      } else {
        warnings.push(
          `参照 ${refAddr} が複数のディレクトリ (${where}) に存在するため一意に解決できません。` +
            `接続線は描きません（推測で別環境を結ばない）。`
        );
      }
    }
    return null;
  };

  // Infer edges between included resources
  const edgeMap = new Map();
  const addEdge = (fromKey, toKey, label, type = "flow") => {
    if (!fromKey || !toKey || fromKey === toKey) return;
    const fromRes = allResources.get(fromKey);
    const toRes = allResources.get(toKey);
    if (!fromRes || !toRes) return;
    const key = `${fromRes.id}->${toRes.id}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, {
        from: fromRes.id,
        to: toRes.id,
        label: label || "",
        type,
      });
    } else if (label && !edgeMap.get(key).label) {
      edgeMap.get(key).label = label;
    }
  };

  // 1. Direct HCL references inside resource bodies.
  //    具体的な実行操作ラベル（Invoke など）は根拠のある箇所に限る。
  //    単なる環境変数・属性参照は "references"（静的参照）として控えめに描く。
  for (const [key, res] of allResources) {
    for (const refAddr of res.refs) {
      const toKey = resolveRef(key, refAddr);
      if (!toKey) continue;
      const target = allResources.get(toKey);

      if (res.kind === "cloudfront" && refAppearsIn(res._originSection, refAddr)) {
        addEdge(key, toKey, "Origin", "flow");
      } else if (res.kind === "sfn") {
        // ASL の「Type が Task のステート」の Resource / Parameters.FunctionName /
        // Arguments.FunctionName に現れる参照だけを実行の根拠とする。Pass ステートの Result など、
        // 実行を意味しない箇所の ARN 出現では Invoke / Task エッジを作らない。
        if (res._invokeRefAddrs && res._invokeRefAddrs.has(refAddr)) {
          addEdge(
            key,
            toKey,
            target.layer === "compute" ? "Invoke" : "Task",
            "flow"
          );
        }
        continue;
      } else if (target.layer === "security") {
        addEdge(key, toKey, "attached", "security");
      } else if (target.layer === "network") {
        addEdge(key, toKey, "in", "network");
      } else {
        addEdge(key, toKey, "references", "reference");
      }
    }
  }

  // 2. Glue resources that connect two included AWS resources
  //    （integration / event source mapping / target などは実行の根拠があるため操作ラベルを付ける）
  //
  // 接続の向きと対象は「属性名の意味」だけで決める。起点属性（topic_arn 等）または
  // 終点属性（endpoint 等）が本文内の変数を指していて解決できない場合に、
  // redrive_policy / dead_letter_config など他属性の SQS へ誤結線しないため、
  // 本文全体（glue.refs）へのフォールバックは行わない。
  const kindOf = (k) => allResources.get(k).kind;
  for (const glue of glueBlocks) {
    const glueKey = `${glue.moduleKey}::${glue.addr}`;
    const rule = GLUE_CONNECT_RULES[glue.type];
    if (!rule) continue;
    const resolveAll = (addrs) =>
      [...new Set((addrs || []).map((a) => resolveRef(glueKey, a)).filter(Boolean))];

    let sourceKeys = resolveAll(
      extractAttributeReferences(glue.refBody, rule.sourceAttrs, {
        topLevelOnly: rule.topLevelSource === true,
      })
    );
    let targetKeys = resolveAll(
      extractAttributeReferences(glue.refBody, rule.targetAttrs, {
        topLevelOnly: rule.topLevelTarget === true,
      })
    );
    if (rule.sourceKinds) sourceKeys = sourceKeys.filter((k) => rule.sourceKinds.includes(kindOf(k)));
    if (rule.targetKinds) targetKeys = targetKeys.filter((k) => rule.targetKinds.includes(kindOf(k)));

    if (sourceKeys.length === 0 || targetKeys.length === 0) continue;

    for (const s of sourceKeys) {
      for (const t of targetKeys) addEdge(s, t, rule.label, rule.edgeType);
    }
  }

  const nodes = [...allResources.values()].map(
    ({
      body: _body,
      refs: _refs,
      _definitionSection: _def,
      _originSection: _org,
      _invokeRefAddrs: _inv,
      ...cleanNode
    }) => cleanNode
  );

  const projectName = path.basename(path.resolve(tfDir));
  // 生成者のホーム絶対パスを残さないため、表示用はカレントディレクトリからの相対
  // （相対にできない場合もディレクトリ名だけにする）
  const relDir = path.relative(process.cwd(), path.resolve(tfDir));
  const sourceDir =
    !relDir || relDir.startsWith("..") || path.isAbsolute(relDir)
      ? projectName
      : relDir.split(path.sep).join("/");
  const includedOptional = [...includeSet].filter((c) => c !== "default");

  return {
    title: title || `AWS アーキテクチャ構成図 (${projectName})`,
    subtitle:
      subtitle ||
      `Terraform (.tf) 自動解析 — 実処理・データ層抽出${
        includedOptional.length > 0 ? ` (+${includedOptional.join(", ")})` : " (SecurityGroup / IAM / ネットワーク補助は省略)"
      }`,
    sourceDir,
    scannedFiles: tfFiles.length,
    includedOptionalCategories: includedOptional,
    omittedSummary,
    warnings,
    nodes,
    edges: [...edgeMap.values()],
  };
}

const HELP_TEXT = `
scan-terraform.mjs - Terraform (.tf) AWS Architecture Resource Scanner

Usage:
  node scripts/scan-terraform.mjs --tf-dir <dir> [-o arch.json] [options]

Options:
  -d, --tf-dir <path>       Directory containing Terraform .tf files (default: .)
  -o, --output <path>       Write extracted JSON spec to file (default: stdout)
      --include <list>      Comma-separated optional categories to include:
                            security, network, iam, observability, all
      --title <text>        Custom diagram title
      --subtitle <text>     Custom diagram subtitle
  -h, --help                Show help
`.trim();

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      "tf-dir": { type: "string", short: "d" },
      output: { type: "string", short: "o" },
      include: { type: "string", default: "" },
      title: { type: "string" },
      subtitle: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const tfDir = values["tf-dir"] || positionals[0] || ".";
  const includeCategories = values.include
    ? values.include.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  // 書き込み前の必須検査: `-o` に .tf やその親ディレクトリを指定されたら、
  // 1 バイトも書く前に止まる（表記だけでなく realpath と (dev, ino) で実体比較する）
  const outputs = [{ role: "-o / --output", value: values.output }];
  const inputEntries = [{ role: "--tf-dir", value: tfDir }];
  const plannedFiles = await collectTerraformFiles(tfDir);
  assertOutputsDistinctFromInputs({
    inputs: [...inputEntries, { role: "スキャン対象 (.tf)", files: plannedFiles }],
    outputs,
  });

  const scannedInputFiles = [];
  const spec = await scanTerraformDirectory(tfDir, {
    includeCategories,
    title: values.title,
    subtitle: values.subtitle,
    files: plannedFiles,
    scannedInputFiles,
  });

  // 実際に走査した一覧で、書き込み直前にもう一度確かめる
  assertOutputsDistinctFromInputs({
    inputs: [...inputEntries, { role: "スキャン対象 (.tf)", files: scannedInputFiles }],
    outputs,
  });

  const jsonStr = JSON.stringify(spec, null, 2);
  if (values.output) {
    await fs.mkdir(path.dirname(resolveWriteTarget(values.output)), { recursive: true });
    await writeFileAtomic(values.output, jsonStr);
    console.error(
      `Scanned ${spec.scannedFiles} .tf files -> ${spec.nodes.length} nodes, ${spec.edges.length} edges -> ${values.output}`
    );
  } else {
    process.stdout.write(jsonStr + "\n");
  }
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => {
    console.error("Error:", err.message || err);
    process.exit(1);
  });
}
