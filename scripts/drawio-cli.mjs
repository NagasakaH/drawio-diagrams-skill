#!/usr/bin/env node
/**
 * drawio-cli.mjs — drawio-diagrams-skill 統合 CLI ディスパッチャ
 *
 * サブコマンドを対応するビルダースクリプトへ透過的に転送するだけの薄い入口。
 * 全サブコマンドはゼロ依存の Pure Node.js (.mjs) で動作する。
 *
 * 使い方:
 *   node scripts/drawio-cli.mjs <command> [args...]
 *
 *   workflow   → scripts/build-workflow.mjs   (スイムレーン業務フロー図)
 *   aws-arch   → scripts/build-aws-arch.mjs   (Terraform → AWS 構成図)
 *   sequence   → scripts/build-sequence.mjs   (UML シーケンス図)
 *   class      → scripts/build-class.mjs      (UML クラス図)
 *   er         → scripts/build-er.mjs         (Crow's Foot ER 図)
 *   state      → scripts/build-state.mjs      (UML 状態遷移図)
 *   c4         → scripts/build-c4.mjs         (C4 Container レベルの構成図)
 *   screen-flow→ scripts/build-screen-flow.mjs(画面遷移図)
 *   png        → scripts/drawio2png.mjs       (.drawio → .drawio.png / .svg 変換)
 *
 * シンボリックリンク経由実行に対応するため、直接実行判定は
 * fsSync.realpathSync(process.argv[1]) を用いる。
 */

import fsSync from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDirectRun } from "./diagram-shared.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const COMMANDS = {
  workflow: {
    script: "build-workflow.mjs",
    summary: "スイムレーン業務フロー図 (JSON spec → .drawio + .drawio.png)",
    example:
      'node scripts/drawio-cli.mjs workflow --spec examples/workflow/order-checkout-workflow.json --direction horizontal --output examples/output/workflow-horizontal.drawio.png',
  },
  "aws-arch": {
    script: "build-aws-arch.mjs",
    summary: "Terraform (.tf) 解析 → AWS アーキテクチャ構成図",
    example:
      'node scripts/drawio-cli.mjs aws-arch --tf-dir examples/aws-arch/sample-terraform --output examples/output/aws-arch-default.drawio.png',
  },
  sequence: {
    script: "build-sequence.mjs",
    summary: "UML シーケンス図 (JSON spec → .drawio + .drawio.png)",
    example:
      'node scripts/drawio-cli.mjs sequence --spec examples/sequence/order-checkout.json --output examples/output/order-checkout-sequence.drawio.png',
  },
  class: {
    script: "build-class.mjs",
    summary: "UML クラス図 (JSON spec / --src-dir スキャン → .drawio + .drawio.png)",
    example:
      'node scripts/drawio-cli.mjs class --spec examples/class/order-domain.json --output examples/output/order-domain-class.drawio.png',
  },
  er: {
    script: "build-er.mjs",
    summary: "SQL DDL / Prisma → Crow\'s Foot ER 図 (.drawio + .drawio.png)",
    example:
      'node scripts/drawio-cli.mjs er --schema examples/er/sample-schema/ecommerce.sql --output examples/output/ecommerce-er.drawio.png',
  },
  state: {
    script: "build-state.mjs",
    summary: "UML 状態遷移図 (JSON spec → .drawio + .drawio.png)",
    example:
      'node scripts/drawio-cli.mjs state --spec examples/state/order-lifecycle.json --output examples/output/order-lifecycle-state.drawio.png',
  },
  c4: {
    script: "build-c4.mjs",
    summary: "C4 Container レベルの構成図 (JSON spec → .drawio + .drawio.png)",
    example:
      'node scripts/drawio-cli.mjs c4 --spec examples/c4/ecommerce-container.json --output examples/output/ecommerce-c4-container.drawio.png',
  },
  "screen-flow": {
    script: "build-screen-flow.mjs",
    summary: "画面遷移図 (JSON spec → .drawio + .drawio.png)",
    example:
      'node scripts/drawio-cli.mjs screen-flow --spec examples/screen-flow/admin-portal.json --output examples/output/admin-portal-screen-flow.drawio.png',
  },
  png: {
    script: "drawio2png.mjs",
    summary: ".drawio / .drawio.png / .xml → PNG / SVG 変換 (XML 埋め込み対応)",
    example: "node scripts/drawio-cli.mjs png diagram.drawio -o diagram.drawio.png --scale 2 --embed-xml",
  },
  shapes: {
    inline: "shapes",
    summary: "shape= / endArrow= に使える名前を検索 (読み取り専用)",
    example: "node scripts/drawio-cli.mjs shapes --query kubernetes --limit 30",
  },
};

const SHAPES_HELP = `
shapes サブコマンド — drawio2png.mjs が描画できる shape 名を検索する（読み取り専用・ファイル書き込みなし）

使い方:
  node scripts/drawio-cli.mjs shapes [--query <kw>] [--limit <n>] [--kind <shape|stencil|marker>]

  --query <kw>   名前を部分一致で絞る（大文字小文字は無視）
  --limit <n>    表示件数（デフォルト 40、0 で全件）
  --kind <k>     表示する分類を絞る。shape=内蔵図形 / stencil=ステンシル / marker=矢印マーカー
`;

/**
 * drawio2png.mjs のランタイムから `shape=` に書ける名前を列挙する。
 * 埋め込みステンシルは遅延ロードなので、検索時に全セットを解凍して名前一束を作る。
 */
async function runShapesCommand(rest) {
  const { parseArgs } = await import("node:util");
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        query: { type: "string", short: "q" },
        limit: { type: "string", short: "n", default: "40" },
        kind: { type: "string", default: "all" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    console.error(`shapes: 引数の解析に失敗しました: ${err.message}`);
    console.error(SHAPES_HELP);
    return 2;
  }
  if (values.help) {
    console.log(SHAPES_HELP.trim());
    return 0;
  }
  const kind = String(values.kind || "all").toLowerCase();
  if (!["all", "shape", "stencil", "marker"].includes(kind)) {
    console.error(`shapes: --kind は all / shape / stencil / marker のいずれかを指定してください: ${kind}`);
    return 2;
  }
  const parsedLimit = parseInt(values.limit, 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit >= 0 ? parsedLimit : 40;

  const { getDrawioOssRuntime } = await import("./drawio2png.mjs");
  const { ctx } = getDrawioOssRuntime();
  const entries = [];
  if (kind === "all" || kind === "shape") {
    for (const name of Object.keys(ctx.mxCellRenderer.defaultShapes || {})) {
      entries.push({ kind: "shape", name, use: `shape=${name}` });
    }
  }
  if (kind === "all" || kind === "stencil") {
    for (const key of ctx.__stencilKeys()) ctx.mxStencilRegistry.loadStencilSetByKey(key);
    for (const name of Object.keys(ctx.mxStencilRegistry.stencils || {})) {
      entries.push({ kind: "stencil", name, use: `shape=${name};sketch=0;` });
    }
  }
  if (kind === "all" || kind === "marker") {
    for (const name of Object.keys(ctx.mxMarker.markers || {})) {
      entries.push({ kind: "marker", name, use: `startArrow=${name};endArrow=${name};` });
    }
  }

  const query = (values.query || "").toLowerCase();
  const hits = query
    ? entries.filter((e) => e.name.toLowerCase().includes(query))
    : entries;
  const kindOrder = { shape: 0, stencil: 1, marker: 2 };
  hits.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.name.localeCompare(b.name));

  const shown = limit > 0 ? hits.slice(0, limit) : hits;
  for (const e of shown) console.log(`${e.kind.padEnd(7)} ${e.use}`);
  const counts = {};
  for (const e of hits) counts[e.kind] = (counts[e.kind] || 0) + 1;
  const summary = Object.entries(counts)
    .map(([k, v]) => `${k} ${v}`)
    .join(" / ");
  console.log(
    `\n一致 ${hits.length} 件（${summary || "なし"}）${
      shown.length < hits.length ? ` / 先頭 ${shown.length} 件を表示。--limit 0 で全件` : ""
    }`
  );
  return 0;
}

function printHelp() {
  const lines = [
    "drawio-cli.mjs — drawio-diagrams-skill 統合 CLI ディスパッチャ",
    "",
    "使い方: node scripts/drawio-cli.mjs <command> [args...]",
    "",
    "サブコマンド:",
  ];
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    lines.push(`  ${name.padEnd(width)}  ${cmd.summary}`);
  }
  lines.push("", "使用例:");
  for (const cmd of Object.values(COMMANDS)) {
    lines.push(`  ${cmd.example}`);
  }
  lines.push(
    "",
    "各サブコマンドの詳しいオプションは対象スクリプトの --help を参照してください。",
    "例: node scripts/drawio-cli.mjs workflow --help",
    "",
    "shape 名を検索する例:",
    "  node scripts/drawio-cli.mjs shapes --query kubernetes"
  );
  console.log(lines.join("\n"));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  // `toString` や `constructor` などの Object 継承プロパティ名をサブコマンドとして
  // 通してしまわないように、自前定義だけを認める。
  if (!command || !Object.hasOwn(COMMANDS, command)) {
    console.error(`不明なサブコマンドです: ${command}`);
    console.error(`利用可能: ${Object.keys(COMMANDS).join(", ")}`);
    console.error("一覧を見るには: node scripts/drawio-cli.mjs --help");
    process.exit(1);
  }

  const target = COMMANDS[command];

  if (target.inline === "shapes") {
    process.exit(await runShapesCommand(rest));
  }

  const scriptPath = path.join(SCRIPT_DIR, target.script);
  const result = spawnSync(process.execPath, [scriptPath, ...rest], {
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`${command} の起動に失敗しました: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

if (isDirectRun(import.meta.url)) {
  await main();
}
