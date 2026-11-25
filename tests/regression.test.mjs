/**
 * regression.test.mjs — レビュー指摘の再発を防ぐ回帰テスト
 *
 * 実行: `npm test`（= `node --test tests/regression.test.mjs`）
 * 依存パッケージは一切使わない（node:test / node:assert / node:fs / node:os のみ）。
 *
 * 設計方針（レビュー指摘への対応）:
 * - XML の健全性は正規表現ではなく draw.io 同梱の mxUtils.parseXml で本格的に検証する
 *   （parsererror 0 件 + セル ID 一意 + parent / source / target の解決）
 * - ER の基数マーカーは凡例サンプルではなく「実関係エッジ」の source / target /
 *   startArrow / endArrow を照合する
 * - 一時ファイル・一時ディレクトリは必ず os.tmpdir()（インストール先をreadOnlyで
 *   開いた環境でも落ちない）
 * - CLI テストはスキルルート以外の cwd（ユーザープロジェクト模擬）から絶対パスで呼ぶ
 */

import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertDistinctPaths,
  emitDiagramFiles,
  ensureLockDir,
  getTargetLockPaths,
  inspectXmlCells,
  resolveWriteTarget,
  splitPathRoot,
  writeFileAtomic,
} from "../scripts/diagram-shared.mjs";
import { extractDrawioXmlFromPng, getDrawioOssRuntime } from "../scripts/drawio2png.mjs";
import { generateC4DiagramXml } from "../scripts/build-c4.mjs";
import { buildDiagramXml as buildClassXml } from "../scripts/build-class.mjs";
import { generateStateDiagramXml } from "../scripts/build-state.mjs";
import { generateScreenFlowXml } from "../scripts/build-screen-flow.mjs";
import { generateSequenceDrawioXml } from "../scripts/build-sequence.mjs";
import {
  buildWorkflowWithLabelCheck,
  generateWorkflowDrawioXml,
} from "../scripts/build-workflow.mjs";
import { generateErDrawioXml } from "../scripts/build-er.mjs";
import { generateAwsArchDrawioXml } from "../scripts/build-aws-arch.mjs";
import { scanSchemaFiles } from "../scripts/scan-schema.mjs";
import { scanDirectory } from "../scripts/scan-classes.mjs";
import { scanTerraformDirectory } from "../scripts/scan-terraform.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "examples", "output");
const FIXTURES = path.join(ROOT, "tests", "fixtures");

const readText = (p) => fsSync.readFileSync(p, "utf8");
const normalize = (s) => String(s).replace(/\r\n/g, "\n").trim();

// ---------------------------------------------------------------------------
// 検査ヘルパー: mxUtils.parseXml による本格的な XML 検証
// ---------------------------------------------------------------------------

let runtimePromise;
const getRt = () => (runtimePromise ??= getDrawioOssRuntime());

/** draw.io 同梱のパーサーでパースし、parsererror があれば即失敗させる。 */
async function parseDoc(xml, label) {
  const { ctx } = await getRt();
  const doc = ctx.mxUtils.parseXml(xml);
  const errs = doc.getElementsByTagName("parsererror");
  assert.equal(
    errs.length,
    0,
    `${label}: XML が構文エラーとしてパースされました: ${errs[0]?.textContent?.slice(0, 200) ?? ""}`
  );
  return doc;
}

/**
 * 図の XML として満たすべき条件を一括検査する:
 * 1. 座標に NaN / Infinity が無い
 * 2. inspectXmlCells（正規表現ベースの高速検査）が問題ゼロ
 * 3. mxUtils.parseXml が parsererror を出さない（真正な XML 構文）
 * 4. パース後のセル ID が一意
 * 5. パース後の parent / source / target が全て実在セルを指す（エスケープ経由でも解決）
 */
async function assertWellFormed(xml, label) {
  assert.ok(!/NaN|Infinity/.test(xml), `${label}: 座標に NaN / Infinity が混入しています`);
  // 属性値・テキスト内の生 & （エスケープ漏れ）を弾く。正当な文字実体参照だけを許す。
  const withoutEntities = xml.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#[xX][0-9a-fA-F]+);/g, "");
  assert.ok(
    !withoutEntities.includes("&"),
    `${label}: XML に未エスケープの & が残っています（属性値やテキストを escapeXml してください）`
  );
  // パースエラーレポート（parsererror）が XML として混入していないかも文字列レベルで見る
  assert.ok(!/parsererror/i.test(xml), `${label}: XML に parsererror が混入しています`);
  const problems = inspectXmlCells(xml);
  assert.deepEqual(problems, [], `${label}: XML に問題があります`);
  const doc = await parseDoc(xml, label);
  const ids = new Set();
  const refs = [];
  for (const c of doc.getElementsByTagName("mxCell")) {
    const id = c.getAttribute("id");
    assert.ok(!ids.has(id), `${label}: mxCell id が重複しています（パース後）: ${id}`);
    ids.add(id);
    for (const attr of ["parent", "source", "target"]) {
      const v = c.getAttribute(attr);
      if (v != null) refs.push([id, attr, v]);
    }
  }
  for (const [id, attr, v] of refs) {
    assert.ok(ids.has(v), `${label}: ${id} の ${attr} が存在しないセルを参照しています（パース後）: ${v}`);
  }
  return doc;
}

/** ER カードの `~hdrname` 子セルから「テーブル名 → カードセル ID」対応表を作る。 */
function erCardIdsOf(doc) {
  const map = new Map();
  for (const c of doc.getElementsByTagName("mxCell")) {
    const id = c.getAttribute("id") || "";
    if (id.endsWith("~hdrname")) map.set(c.getAttribute("value"), id.slice(0, -"~hdrname".length));
  }
  return map;
}

/**
 * assertWellFormed 自身が「生の &」と parsererror を弾くこと自体の回帰テスト。
 * 検査が弱体化して High の再発を見逃すのを防ぐ。
 */
test("assertWellFormed: 未エスケープの & と parsererror を弾き、正当な実体参照は通す", async () => {
  const wrap = (value) =>
    `<mxfile><diagram name="d"><mxGraphModel><root>` +
    `<mxCell id="0" /><mxCell id="1" parent="0" />` +
    `<mxCell id="c1" value="${value}" style="rounded=0;html=1;" vertex="1" parent="1">` +
    `<mxGeometry x="10" y="10" width="40" height="20" as="geometry" /></mxCell>` +
    `</root></mxGraphModel></diagram></mxfile>`;

  await assert.rejects(
    () => assertWellFormed(wrap("A & B"), "bare-&"),
    /未エスケープの &/,
    "属性値の生 & を通してしまっています"
  );
  await assert.rejects(
    () =>
      assertWellFormed(
        `<?xml version="1.0"?>\n<parsererror xmlns:xmlns="http://www.w3.org/2005/10/parser/"><h1>this is broken</h1></parsererror>`,
        "parsererror"
      ),
    /parsererror/,
    "parsererror レポートを通してしまいました"
  );
  // &amp; / &lt; / 数値参照は正当なので通す
  await assertWellFormed(wrap("A &amp; B &lt; C &#65;"), "escaped-entities");
});

const SAMPLE_DIAGRAMS = [
  "workflow-horizontal",
  "aws-arch-default",
  "order-checkout-sequence",
  "order-domain-class",
  "ecommerce-er",
  "order-lifecycle-state",
  "ecommerce-c4-container",
  "admin-portal-screen-flow",
];

// ---------------------------------------------------------------------------
// 1. 同梱サンプル: PNG 埋め込み XML と隣接 .drawio の一致 / XML の健全性
// ---------------------------------------------------------------------------

test("examples/output: .drawio.png に埋め込まれた XML が隣接する .drawio と一致する", () => {
  for (const base of SAMPLE_DIAGRAMS) {
    const pngPath = path.join(OUT_DIR, `${base}.drawio.png`);
    const xmlPath = path.join(OUT_DIR, `${base}.drawio`);
    assert.ok(fsSync.existsSync(pngPath), `${base}.drawio.png がありません（npm run demo を実行）`);
    const embedded = extractDrawioXmlFromPng(fsSync.readFileSync(pngPath));
    assert.ok(embedded, `${base}.drawio.png から XML を取り出せません`);
    assert.equal(
      normalize(embedded),
      normalize(readText(xmlPath)),
      `${base}: PNG 埋め込み XML と ${base}.drawio が一致しません`
    );
  }
});

test("examples/output: 8 図とも mxUtils.parseXml で健全（ID 一意・参照解決・NaN ゼロ）", async () => {
  for (const base of SAMPLE_DIAGRAMS) {
    const xml = readText(path.join(OUT_DIR, `${base}.drawio`));
    await assertWellFormed(xml, base);
    if (base === "order-lifecycle-state") {
      assert.ok(!/height="NaN"/.test(xml), "状態図の activity ラベルの高さが NaN になっています");
    }
  }
});

// ---------------------------------------------------------------------------
// 2. ER: 基数の推定規則と、実関係エッジの source / target / マーカー
// ---------------------------------------------------------------------------

const relKey = (r) => `${r.from}->${r.to}`;
const relMap = (spec) => new Map(spec.relations.map((r) => [relKey(r), r.cardinality]));

test("ER(SQL): NOT NULL / NULL 許容 / UNIQUE / 複合主キーの一部列で基数が決まる", async () => {
  const spec = await scanSchemaFiles([path.join(FIXTURES, "schema", "cardinality.sql")]);
  const got = relMap(spec);
  assert.equal(got.get("users->orders"), "1:0..N", "NOT NULL FK かつ UNIQUE でない子側は 0..N");
  assert.equal(got.get("users->profiles"), "1:0..1", "NOT NULL FK かつ列全体が PK なら子側 0..1");
  assert.equal(got.get("users->user_settings"), "0..1:0..1", "NULL 許容 FK + UNIQUE は親側 0..1");
  assert.equal(got.get("tags->product_tags"), "0..1:0..1", "NULL 許容 FK + UNIQUE は 0..1:0..1");
  assert.equal(
    got.get("orders->order_lines"),
    "1:0..N",
    "複合主キーの一部だけを参照する FK は UNIQUE 集合ではないので 0..N でなければならない"
  );
});

test("ER(Prisma): 単独 PK / 複合 PK / NULL 許容 UNIQUE の基数が SQL と同じ規則で決まる", async () => {
  const spec = await scanSchemaFiles([path.join(FIXTURES, "schema", "library.prisma")]);
  const got = relMap(spec);
  assert.equal(got.get("Member->Profile"), "1:0..1");
  assert.equal(got.get("Member->Membership"), "0..1:0..1");
  assert.equal(
    got.get("Member->Blog"),
    "1:0..N",
    "@@id([authorId, slug]) の一部だけの参照は多数側になる"
  );
});

test("ER(同梱サンプル): users→addresses は 1:0..N、categories→categories は 0..1:0..N", async () => {
  const spec = await scanSchemaFiles([path.join(ROOT, "examples", "er", "sample-schema", "ecommerce.sql")]);
  const got = relMap(spec);
  assert.equal(got.get("users->addresses"), "1:0..N");
  assert.equal(got.get("categories->categories"), "0..1:0..N", "自己参照の parent_id は NULL 許容");
  assert.equal(got.get("addresses->orders"), "0..1:0..N", "shipping_address_id は NULL 許容");
});

const CARDINALITY_MARKERS = {
  "1:N": ["ERmandOne", "ERoneToMany"],
  "1:1": ["ERmandOne", "ERmandOne"],
  "1:0..1": ["ERmandOne", "ERzeroToOne"],
  "1:0..N": ["ERmandOne", "ERzeroToMany"],
  "0..1:N": ["ERzeroToOne", "ERoneToMany"],
  "0..1:0..1": ["ERzeroToOne", "ERzeroToOne"],
  "0..1:0..N": ["ERzeroToOne", "ERzeroToMany"],
};

test("ER: 実関係エッジの source / target / マーカーが spec の cardinality と一致する（凡例で誤魔化さない）", async () => {
  const spec = await scanSchemaFiles([path.join(FIXTURES, "schema", "cardinality.sql")]);
  const xml = generateErDrawioXml(spec);
  const doc = await assertWellFormed(xml, "er/markers");

  const cardIds = erCardIdsOf(doc);
  const realEdges = [...doc.getElementsByTagName("mxCell")].filter(
    (c) => c.getAttribute("edge") === "1" && c.getAttribute("source") != null
  );
  assert.ok(
    realEdges.length >= spec.relations.length,
    `実関係エッジ（source / target 付き）が見つかりません: edges=${realEdges.length}, relations=${spec.relations.length}`
  );

  for (const r of spec.relations) {
    const parentCard = cardIds.get(r.from);
    const childCard = cardIds.get(r.to);
    assert.ok(parentCard && childCard, `テーブル ${r.from} / ${r.to} のカードセルが見つかりません`);
    const [start, end] = CARDINALITY_MARKERS[r.cardinality];
    const styleOf = (c) => c.getAttribute("style") || "";
    const hit = realEdges.find(
      (c) =>
        c.getAttribute("source") === parentCard &&
        c.getAttribute("target") === childCard &&
        styleOf(c).includes(`startArrow=${start};`) &&
        styleOf(c).includes(`endArrow=${end};`)
    );
    assert.ok(
      hit,
      `${r.from}->${r.to}（${r.cardinality}）の実関係エッジが source / target / マーカー付きで存在しません`
    );
    assert.ok(
      !hit.getAttribute("id").startsWith("lg_"),
      "凡例サンプルが実関係として拾われました（検査が緩んでいます）"
    );
  }
  assert.ok(xml.includes("0..1 : 0..N"), "凡例に 0..1 : 0..N の見本行がありません");
});

test("ER: カードの子セル（列・バッジ）がカード ID の child として再編集可能", async () => {
  const spec = await scanSchemaFiles([path.join(FIXTURES, "schema", "cardinality.sql")]);
  const doc = await parseDoc(generateErDrawioXml(spec), "er/parent-child");
  const cardIds = erCardIdsOf(doc);
  const usersCard = cardIds.get("users");
  assert.ok(usersCard, "users カードがありません");
  const children = [...doc.getElementsByTagName("mxCell")].filter((c) => c.getAttribute("parent") === usersCard);
  assert.ok(children.length >= 4, `users カードの子セルが多すぎ / 少なすぎます: ${children.length}`);
  const values = children.map((c) => c.getAttribute("value") || "");
  assert.ok(values.includes("users"), "ヘッダー名の子セルがありません");
  assert.ok(values.includes("id"), "列名の子セルがありません");
});

test("ER: 表名が正規形で行き違っても（`a.b` / `a/b` / `a_b`）セル ID が衝突しない", async () => {
  const col = (name, extra = {}) => ({ name, type: "text", ...extra });
  const spec = {
    title: "衝突検査",
    tables: [
      { name: "a.b", columns: [col("id", { pk: true })] },
      { name: "a/b", columns: [col("id", { pk: true }), col("a_b_id", { fk: true })] },
      { name: "a_b", columns: [col("id", { pk: true })] },
    ],
    relations: [
      { id: "r1", from: "a.b", to: "a/b", fromColumns: ["id"], toColumns: ["a_b_id"], cardinality: "1:0..N" },
    ],
  };
  await assertWellFormed(generateErDrawioXml(spec), "er/id-collision");
});

// ---------------------------------------------------------------------------
// 3. Terraform: ディレクトリ（モジュール / 環境）別の識別と接続根拠
// ---------------------------------------------------------------------------

const MULTI_ENV = path.join(FIXTURES, "terraform-multi-env");

test("Terraform: 別ディレクトリの同名リソースを別ノードとして保持し、warnings を出す", async () => {
  const spec = await scanTerraformDirectory(MULTI_ENV);
  const ids = spec.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, "ノード ID が重複しています");

  const dev = spec.nodes.find((n) => n.tfAddress === "aws_lambda_function.api" && n.module === "env/dev");
  const prod = spec.nodes.find((n) => n.tfAddress === "aws_lambda_function.api" && n.module === "env/prod");
  assert.ok(dev && prod, "dev / prod の同名 Lambda が両方ノード化していません");
  assert.notEqual(dev.id, prod.id);
  assert.match(spec.warnings.join("\n"), /同名/);
});

test("Terraform: 参照は同じディレクトリを優先し、一意に決まらない参照は線にしない", async () => {
  const spec = await scanTerraformDirectory(MULTI_ENV);
  const idOf = (addr, mod) => spec.nodes.find((n) => n.tfAddress === addr && n.module === mod)?.id;
  const edgesFrom = (id) => spec.edges.filter((e) => e.from === id);

  const devApi = idOf("aws_lambda_function.api", "env/dev");
  const prodApi = idOf("aws_lambda_function.api", "env/prod");
  assert.ok(edgesFrom(devApi).some((e) => e.to === idOf("aws_sqs_queue.orders_queue", "env/dev")));
  assert.ok(
    !edgesFrom(devApi).some((e) =>
      [idOf("aws_dynamodb_table.audit", "env/prod"), idOf("aws_sqs_queue.orders_queue", "env/prod")].includes(e.to)
    ),
    "dev の Lambda が prod のリソースへ線を張っています"
  );
  assert.ok(edgesFrom(prodApi).some((e) => e.to === idOf("aws_sqs_queue.orders_queue", "env/prod")));

  const notifier = idOf("aws_lambda_function.notifier", ".");
  assert.equal(
    edgesFrom(notifier).length,
    0,
    "同名でどちらか決まらない参照を推測で接続しています（警告のみが正しい）"
  );
  assert.match(spec.warnings.join("\n"), /一意に解決できません/);
});

test("Terraform: SFN は Task ステートの Resource だけ結び、Pass 内の ARN 参照では結ばない", async () => {
  const spec = await scanTerraformDirectory(MULTI_ENV);
  const idOf = (addr) => spec.nodes.find((n) => n.tfAddress === addr)?.id;
  const sfn = idOf("aws_sfn_state_machine.orchestrator");
  const worker = idOf("aws_lambda_function.worker");
  const mailer = idOf("aws_lambda_function.mailer");
  assert.ok(sfn && worker && mailer, "orchestrator / worker / mailer のいずれかがノードにありません");

  const pairs = spec.edges.map((e) => `${e.from}=>${e.to}`);
  assert.ok(pairs.includes(`${sfn}=>${worker}`), "Task ステート（Resource）の Invoke 線がありません");
  assert.ok(
    !pairs.includes(`${sfn}=>${mailer}`) && !pairs.includes(`${mailer}=>${sfn}`),
    "Pass ステートの Result にある ARN を実行の根拠として結んでいます"
  );
  assert.ok(spec.edges.every((e) => !(e.from === sfn && e.to === mailer)));
});

test("Terraform: 操作名のラベルは実行の証拠がある線だけにつけ、 env 変数参照は references になる", async () => {
  const spec = await scanTerraformDirectory(path.join(ROOT, "examples", "aws-arch", "sample-terraform"));
  const labelOf = (fromAddr, toAddr) => {
    const from = spec.nodes.find((n) => n.tfAddress === fromAddr)?.id;
    const to = spec.nodes.find((n) => n.tfAddress === toAddr)?.id;
    return spec.edges.find((e) => e.from === from && e.to === to);
  };
  assert.equal(
    labelOf("aws_apigatewayv2_api.orders_http_api", "aws_lambda_function.order_api")?.label,
    "Invoke",
    "API Gateway の integration は Invoke"
  );
  assert.equal(
    labelOf("aws_sfn_state_machine.order_orchestrator", "aws_lambda_function.payment_worker")?.label,
    "Invoke",
    "Step Functions の definition 内 Resource は Invoke"
  );
  assert.equal(
    labelOf("aws_sqs_queue.order_events", "aws_lambda_function.payment_worker")?.label,
    "Trigger / Poll",
    "event source mapping は Trigger / Poll"
  );
  assert.equal(
    labelOf("aws_cloudwatch_event_rule.daily_reconcile", "aws_sfn_state_machine.order_orchestrator")?.label,
    "Target",
    "EventBridge の target は Target"
  );
  const envRef = labelOf("aws_lambda_function.order_api", "aws_dynamodb_table.cart_sessions");
  assert.equal(envRef?.label, "references", "環境変数内の参照は操作名ではなく references にする");
  assert.equal(envRef?.type, "reference");
});

test("Terraform: JSON spec に生成元の絶対パス（ホームディレクトリ）を混ぜない", async () => {
  const spec = await scanTerraformDirectory(MULTI_ENV);
  const json = JSON.stringify(spec);
  assert.ok(!json.includes(os.homedir()), "spec にホームディレクトリの絶対パスが混入しています");
  assert.ok(!path.isAbsolute(spec.sourceDir), `sourceDir が絶対パスです: ${spec.sourceDir}`);
  const sample = JSON.parse(readText(path.join(OUT_DIR, "aws-arch-default.json")));
  assert.ok(!JSON.stringify(sample).includes("/Users/"), "examples/output/aws-arch-default.json にユーザードライブ直下の絶対パスが有ります");
});

test("Terraform: 別環境を含む spec でも AWS 図の XML が健全で凡例に Static reference が出る", async () => {
  const spec = await scanTerraformDirectory(MULTI_ENV);
  const xml = generateAwsArchDrawioXml(spec);
  await assertWellFormed(xml, "aws-arch/multi-env");
  assert.ok(xml.includes("Static reference"), "reference 線の凡例がありません");
});

test("AWS 図: 存在しないノードを指すエッジは描かず、warnings で利用者に伝える", async () => {
  const spec = await scanTerraformDirectory(MULTI_ENV);
  spec.edges.push({ from: spec.nodes[0].id, to: "ghost_node_does_not_exist", label: "参照" });
  const genWarnings = [];
  const xml = generateAwsArchDrawioXml(spec, { warnings: genWarnings });
  await assertWellFormed(xml, "aws-arch/unknown-edge");
  assert.ok(
    genWarnings.some((w) => w.includes("ghost_node_does_not_exist") && w.includes("結びませんでした")),
    `不明な接続先の警告が出ていません: ${JSON.stringify(genWarnings)}`
  );
});

// ---------------------------------------------------------------------------
// 4. セル ID の衝突・エスケープ（CJK / 記号 / R&D）
// ---------------------------------------------------------------------------

const COLLIDING = ["注文", "顧客", "a.b", "a/b", "a_b"];

test("C4: 日本語 ID と記違い ID が mxCell ID で衝突しない", async () => {
  const spec = {
    title: "ID 衝突検査",
    boundaries: [{ id: "境界", label: "自社システム", kind: "Software System" }],
    elements: [
      { id: "人", kind: "person", name: "ユーザ", description: "購入する人", row: 0, col: 0 },
      ...COLLIDING.map((id, i) => ({
        id,
        kind: "container",
        name: `C${i}`,
        tech: "Node.js",
        description: "説明",
        boundary: "境界",
        row: i + 1,
        col: 1,
      })),
    ],
    relationships: [
      { from: "人", to: "注文", label: "注文する / HTTPS", kind: "sync" },
      { from: "注文", to: "a.b", label: "参照 / SQL", kind: "sync" },
      { from: "a/b", to: "a_b", label: "参照 / SQL", kind: "sync" },
    ],
  };
  await assertWellFormed(generateC4DiagramXml(spec), "c4/id-collision");
});

test("C4: 同じ (row, col) を指定した要素は警告を出して空きマスへずれ、両方描かれる", async () => {
  const spec = {
    title: "配置衝突検査",
    elements: [
      { id: "a", kind: "container", name: "A-kept", tech: "Node.js", row: 0, col: 0 },
      { id: "b", kind: "container", name: "B-shifted", tech: "Go", row: 0, col: 0 },
    ],
    relationships: [],
  };
  const warnings = [];
  const xml = generateC4DiagramXml(spec, { warnings });
  await assertWellFormed(xml, "c4/dup-cell");
  assert.ok(
    warnings.some((w) => w.includes("配置衝突") && w.includes("要素 b") && w.includes("col=1")),
    `配置衝突の警告がありません: ${JSON.stringify(warnings)}`
  );
  const doc = await parseDoc(xml, "c4/dup-cell");
  const xs = [];
  for (const c of doc.getElementsByTagName("mxCell")) {
    const value = c.getAttribute("value") || "";
    if (!/A-kept|B-shifted/.test(value) || c.getAttribute("vertex") !== "1") continue;
    const geo = c.getElementsByTagName("mxGeometry")[0];
    if (geo) xs.push(geo.getAttribute("x"));
  }
  assert.equal(xs.length, 2, `A / B の本体セルが見つかりません: ${JSON.stringify(xs)}`);
  assert.notEqual(xs[0], xs[1], "重複座標の 2 要素が同じ位置に重なって描かれています");
});

test("クラス図: 日本語クラス名と記違い名が属性 / 関係セルでも衝突しない", async () => {
  const spec = {
    title: "ID 衝突検査",
    classes: COLLIDING.map((id, i) => ({
      id,
      name: `K${i}`,
      stereotype: "entity",
      attributes: [`attr${i}: string`],
      methods: [`op${i}(): void`],
    })),
    relations: [
      { from: "注文", to: "顧客", type: "association", fromMultiplicity: "1", toMultiplicity: "0..*" },
      { from: "a.b", to: "a/b", type: "dependency" },
      { from: "a_b", to: "注文", type: "generalization" },
    ],
  };
  await assertWellFormed(buildClassXml(spec), "class/id-collision");
});

test("状態遷移図: 日本語状態 ID と記違い ID がアクション / 遷移セルでも衝突しない", async () => {
  const spec = {
    title: "ID 衝突検査",
    states: [
      ...COLLIDING.map((id, i) => ({ id, name: `S${i}`, entry: `entry ${i}` })),
      { id: "初", kind: "initial" },
      { id: "終", kind: "final" },
    ],
    transitions: [
      { from: "初", to: "注文" },
      { from: "注文", to: "顧客", label: "確定" },
      { from: "a.b", to: "a/b", label: "x & y" },
      { from: "a_b", to: "終" },
    ],
  };
  const xml = generateStateDiagramXml(spec);
  await assertWellFormed(xml, "state/id-collision");
  assert.ok(!/height="NaN"/.test(xml), "アクション行の高さが NaN になっています");
});

test("画面遷移図: 日本語画面 ID と記違い ID がモーダル / ノートでも衝突しない", async () => {
  const spec = {
    title: "ID 衝突検査",
    groups: [{ id: "G&1", name: "管理者 & 一般" }],
    screens: COLLIDING.map((id, i) => ({
      id,
      name: `画面 ${i}`,
      route: `/p${i}`,
      group: "G&1",
      note: "注記 & 補足",
    })),
    transitions: [
      { from: "注文", to: "顧客", label: "一覧 & 詳細" },
      { from: "a.b", to: "a/b", label: "x / y" },
      { from: "a/b", to: "a_b" },
    ],
  };
  await assertWellFormed(generateScreenFlowXml(spec), "screen-flow/id-collision");
});

test("ワークフロー: `R&D` レーンで効果ブロック（effect）の子セルも壊れず解決する（横・縦）", async () => {
  const spec = {
    title: "R&D レーン検査",
    lanes: [
      { id: "R&D", title: "R&D / 研究", subtitle: "a & b" },
      { id: "db", title: "DB", subtitle: "" },
    ],
    nodes: [
      { id: "n1", lane: "R&D", row: 0, col: 0, label: "開始 & 終了", effect: ["lock & write", "notify"] },
      { id: "n2", lane: "db", row: 1, col: 0, label: "保存" },
    ],
    edges: [{ from: "n1", to: "n2", label: "write & read" }],
  };
  for (const direction of ["horizontal", "vertical"]) {
    const xml = generateWorkflowDrawioXml({ ...spec, direction });
    const doc = await assertWellFormed(xml, `workflow/${direction}`);

    const cells = [...doc.getElementsByTagName("mxCell")];
    // レーン ID `R&D` は共有アロケータで安全なセル ID（`lane-R_D`）へ正規化される。
    // 生の & が ID に残っていれば XML は壊れるので、そこも明示的に見る。
    const laneCells = cells.filter((c) => (c.getAttribute("style") || "").includes("swimlane;"));
    assert.equal(laneCells.length, 2, `${direction}: レーンセルが 2 本生成されていません`);
    const rdLane = laneCells.find((c) => (c.getAttribute("id") || "").includes("R_D"));
    assert.ok(rdLane, `${direction}: レーン ID \`R&D\` が安全なセル ID へ正規化されていません`);
    assert.ok(
      !/&/.test(rdLane.getAttribute("id")),
      `${direction}: セル ID に生の & が残っています: ${rdLane.getAttribute("id")}`
    );

    // エフェクトブロック（効果テキストを含む子セル）がパース後にレーンセルの子として
    // 解決されること。二重エスケープや ID 衝突ならここで dangling になり
    // assertWellFormed が落ちる。
    const effects = cells.filter((c) => (c.getAttribute("value") || "").includes("lock &amp; write")
      || (c.getAttribute("value") || "").includes("lock & write"));
    assert.ok(effects.length >= 1, `${direction}: 効果ブロックの子セルが見つかりません`);
    for (const eff of effects) {
      assert.equal(
        eff.getAttribute("parent"),
        rdLane.getAttribute("id"),
        `${direction}: 効果ブロックの parent が解決できていません`
      );
    }
    // 値は draw.io の html 意味論で二重にエスケープされる（属性パース後にも
    // `<b>開始 &amp; 終了</b>` として HTML テキストが残るのが正しい姿）
    const nodeCells = cells.filter((c) => (c.getAttribute("value") || "").includes("開始"));
    assert.ok(nodeCells.length >= 1, `${direction}: ノード本体が見つかりません`);
    assert.ok(nodeCells.some((c) => (c.getAttribute("value") || "").includes("&amp;")),
      `${direction}: ノード値の & が HTML エスケープされたまま解決できません`);
  }
});

test("ワークフロー: 接続先に存在しないノードを指すエッジは描かず warnings で伝える", () => {
  const spec = {
    title: "未知ノード検査",
    lanes: [
      { id: "a", title: "操作" },
      { id: "b", title: "保存" },
    ],
    nodes: [
      { id: "n1", lane: "a", row: 0, col: 0, label: "開始" },
      { id: "n2", lane: "b", row: 1, col: 0, label: "保存" },
    ],
    edges: [
      { from: "n1", to: "n2", label: "実行" },
      { from: "n1", to: "ghost", label: "消えた線" },
    ],
  };
  const res = buildWorkflowWithLabelCheck(spec, "horizontal");
  assert.ok(
    res.warnings.some((w) => w.includes("ghost") && w.includes("結ばれませんでした")),
    `未知ノードを指すエッジの警告がありません: ${JSON.stringify(res.warnings)}`
  );
  assert.ok(!res.xml.includes('target="ghost"'), "未知ノードへのエッジが描かれています");
});

test("シーケンス図: メッセージ 0 件でも断片・ノート・アクティベーションだけで NaN にならない", async () => {
  const base = {
    title: "空メッセージ検査",
    participants: [
      { id: "a", name: "A", kind: "service" },
      { id: "b", name: "B", kind: "database" },
    ],
    messages: [],
  };
  const cases = {
    fragments: { ...base, fragments: [{ type: "alt", label: "x", fromStep: 1, toStep: 2 }] },
    notes: { ...base, notes: [{ atStep: 3, text: "注記 & 説明", participants: ["a", "b"] }] },
    activations: { ...base, activations: [{ participant: "a", fromStep: 1, toStep: 4 }] },
    empty: base,
  };
  for (const [name, spec] of Object.entries(cases)) {
    await assertWellFormed(generateSequenceDrawioXml(spec), `sequence/${name}`);
  }
});

// ---------------------------------------------------------------------------
// 5. スキャナ: シンボリックリンク / スキーマ修飾 / Prisma 複数ファイル
// ---------------------------------------------------------------------------

test("scan-schema: 既定で symlink を辿らず、循環・切断リンクでも落ちない", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-scan-"));
  try {
    const inside = path.join(tmp, "schema");
    const outside = path.join(tmp, "outside");
    await fs.mkdir(inside, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(inside, "a.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY);\n");
    await fs.writeFile(path.join(outside, "b.sql"), "CREATE TABLE b (id INTEGER PRIMARY KEY);\n");
    // ルート内の別ディレクトリへ出るリンク / ルート外へ出るリンク / 切断リンク / 循環リンク
    const linkResults = await Promise.all([
      trySymlink(path.join(tmp, "outside"), path.join(inside, "escape")),
      trySymlink(path.join(inside, "a.sql"), path.join(inside, "link.sql")),
      trySymlink(path.join(inside, "nowhere.sql"), path.join(inside, "broken.sql")),
      trySymlink(inside, path.join(inside, "self")),
    ]);
    if (linkResults.some((ok) => !ok)) {
      t.skip("symlink を作成できない環境のためスキップ");
      return;
    }

    const spec = await scanSchemaFiles([inside]);
    assert.deepEqual(
      spec.tables.map((t) => t.name).sort(),
      ["a"],
      "symlink 先（ルート外や循環先）のスキーマを拾っています"
    );

    // 明示的に追跡しても循環で無限再帰しない（ELOOP を例外にしない）
    const followed = await scanSchemaFiles([inside], { followSymlinks: true });
    assert.ok(Array.isArray(followed.tables));
    assert.ok(followed.tables.some((t) => t.name === "a"));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("scan-schema(SQL): スキーマ修飾付きの同名表を統合せず、修飾名で関係を結ぶ", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-sql-"));
  try {
    await fs.writeFile(
      path.join(tmp, "sales.sql"),
      "CREATE TABLE sales.orders (id BIGINT PRIMARY KEY);\n"
    );
    await fs.writeFile(
      path.join(tmp, "audit.sql"),
      "CREATE TABLE audit.orders (id BIGINT PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES sales.orders(id));\n"
    );
    const spec = await scanSchemaFiles([tmp]);
    const names = spec.tables.map((t) => t.name).sort();
    assert.deepEqual(names, ["audit.orders", "sales.orders"], "別スキーマの同名表 orders が統合されています");
    const rel = spec.relations.find((r) => r.to === "audit.orders");
    assert.equal(rel?.from, "sales.orders", "修飾名付きの FK 関係が解決できていません");
    assert.equal(rel?.cardinality, "1:0..N");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("scan-schema(Prisma): 複数ファイルにまたがる relation を失わない", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-prisma-"));
  try {
    await fs.writeFile(
      path.join(tmp, "a.prisma"),
      ["model A {", "  id  String  @id", "  bId String?", "  b   B?      @relation(fields: [bId], references: [id])", "}", ""].join("\n")
    );
    await fs.writeFile(
      path.join(tmp, "b.prisma"),
      ["model B {", "  id String @id", "  a  A[]", "}", ""].join("\n")
    );
    const spec = await scanSchemaFiles([tmp]);
    assert.deepEqual(spec.tables.map((t) => t.name).sort(), ["A", "B"]);
    const got = relMap(spec);
    assert.equal(got.get("B->A"), "0..1:0..N", "ファイル横断の relation（bId → B.id）が失われています");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
// 6. drawio2png.mjs: 単一ファイル完結と、インストール先依存のなさ
// ---------------------------------------------------------------------------

test("drawio2png.mjs: ローカルファイルの静的 import を持たない（単一ファイルで完結）", () => {
  const src = readText(path.join(ROOT, "scripts", "drawio2png.mjs"));
  assert.ok(
    !/from\s+["'`]\.{1,2}\//.test(src),
    "drawio2png.mjs にローカル相対パスの静的 import があります（単一ファイル完結の主張が嘘になります）"
  );
});

test("drawio2png.mjs: スキルルート以外を cwd にしても単独で import できる", () => {
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "drawio-standalone-"));
  try {
    const url = pathToFileURL(path.join(ROOT, "scripts", "drawio2png.mjs")).href;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)});`], {
      cwd: tmp,
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(res.status, 0, `別 cwd からの import に失敗: ${res.stderr}`);
  } finally {
    fsSync.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ランタイム: 新しいコンテキストでも遅延ステンシルが解決できる（shapes 列挙と一致）", async () => {
  const { ctx } = await getRt();
  // resourceIcon は描画クラス側の実装なので、ステンシルとして遅延解決される
  // 実アイコン名とフォールバックが必要なドット含み名を検証する
  const names = ["mxgraph.aws4.lambda", "mxgraph.kubernetes.pod", "mxgraph.webicons.last.fm"];
  for (const name of names) {
    assert.ok(ctx.mxStencilRegistry.getStencil(name), `新しいコンテキストで ${name} が解決できません`);
  }
});

// ---------------------------------------------------------------------------
// 7. 出力パス衝突の事前検査と CLI の挙動（cwd はユーザープロジェクト模擬）
// ---------------------------------------------------------------------------

test("assertDistinctPaths: resolve 後に同一とみなせる入出力を拒否し、別々なら通す", () => {
  assert.doesNotThrow(() =>
    assertDistinctPaths([
      { role: "--spec", value: "a/in.json" },
      { role: "--output", value: "a/out.png" },
      { role: "--xml-out", value: "./a/out.drawio" },
    ])
  );
  assert.throws(
    () =>
      assertDistinctPaths([
        { role: "--xml-out", value: "x/a.drawio" },
        { role: "--output", value: path.resolve("x", "a.drawio") },
      ]),
    /衝突/
  );
  assert.throws(
    () =>
      assertDistinctPaths([
        { role: "--spec", value: "x/a.json" },
        { role: "--output", value: "x/a.json" },
      ]),
    /衝突/
  );
});

const cli = (args, cwd = ROOT) =>
  spawnSync(process.execPath, [path.join(ROOT, "scripts", "drawio-cli.mjs"), ...args], {
    encoding: "utf8",
    cwd,
    timeout: 180000,
  });

test("CLI: スキルート外の cwd（ユーザープロジェクト模擬）から絶対パスで呼んで生成できる", () => {
  const proj = fsSync.mkdtempSync(path.join(os.tmpdir(), "drawio-proj-"));
  try {
    fsSync.writeFileSync(
      path.join(proj, "db.sql"),
      "CREATE TABLE users (id INTEGER PRIMARY KEY);\nCREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id));\n"
    );
    const res = cli(["er", "--schema", "db.sql", "--output", "docs/diagrams/er.drawio.png"], proj);
    assert.equal(res.status, 0, `er 生成に失敗: ${res.stderr}`);
    assert.ok(fsSync.existsSync(path.join(proj, "docs", "diagrams", "er.drawio")));
    assert.ok(fsSync.existsSync(path.join(proj, "docs", "diagrams", "er.drawio.png")));
    // PNG を見たら、XML が書き出し済み .drawio と同じであること
    const embedded = extractDrawioXmlFromPng(
      fsSync.readFileSync(path.join(proj, "docs", "diagrams", "er.drawio.png"))
    );
    assert.equal(normalize(embedded), normalize(fsSync.readFileSync(path.join(proj, "docs", "diagrams", "er.drawio"), "utf8")));
  } finally {
    fsSync.rmSync(proj, { recursive: true, force: true });
  }
});

test("CLI: --output と --xml-out が同じファイルなら変換前に exit(1) で、ファイルを一切作らない", () => {
  const proj = fsSync.mkdtempSync(path.join(os.tmpdir(), "drawio-collide-"));
  try {
    fsSync.writeFileSync(path.join(proj, "db.sql"), "CREATE TABLE t (id INTEGER PRIMARY KEY);\n");
    const res = cli(["er", "--schema", "db.sql", "--output", "out/x.drawio.png", "--xml-out", "out/x.drawio.png"], proj);
    assert.notEqual(res.status, 0, "パス衝突を exit(1) で拒否していません");
    assert.match(res.stderr, /衝突/);
    assert.ok(!fsSync.existsSync(path.join(proj, "out")), "衝突時に出力ディレクトリを作ってしまいました");
  } finally {
    fsSync.rmSync(proj, { recursive: true, force: true });
  }
});

test("CLI: shapes で `shape=` に書ける名前を検索できる", () => {
  const res = cli(["shapes", "--query", "kubernetes", "--limit", "20"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /mxgraph\.kubernetes/);

  const marker = cli(["shapes", "--query", "doubleBlock", "--kind", "marker"]);
  assert.equal(marker.status, 0, marker.stderr);
  assert.match(marker.stdout, /doubleBlock/);

  const bad = cli(["shapes", "--kind", "nope"]);
  assert.equal(bad.status, 2);
});

test("CLI: --help は 0 で終わり、Object 継承名のサブコマンドは拒否する", () => {
  assert.equal(cli(["--help"]).status, 0);
  const res = cli(["toString"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /不明なサブコマンド/);
});

// ---------------------------------------------------------------------------
// 8. 配置検査と、ドキュメント / NOTICE の実態一致
// ---------------------------------------------------------------------------

test("check-layout: 自分の線の上と枠の内側のラベルを誤検出しない", async () => {
  const { inspectDiagram } = await import("../scripts/check-layout.mjs");
  // ER 図は関係ラベルが自分の線の途中に載る。修正前は 8 件すべてが
  // 「線と文字の重なり」として指摘されていた。
  const er = await fs.readFile(path.join(OUT_DIR, "ecommerce-er.drawio"), "utf8");
  const erProblems = inspectDiagram(er).problems;
  assert.deepEqual(
    erProblems.map((p) => `${p.kind}: ${p.labelId} × ${p.other}`),
    [],
    `ER 図の配置検査に誤検出: ${JSON.stringify(erProblems)}`
  );

  // 画面遷移図は破線グループ枠の中にラベルが入る。枠の内側は衝突ではない。
  const flow = await fs.readFile(path.join(OUT_DIR, "admin-portal-screen-flow.drawio"), "utf8");
  const flowProblems = inspectDiagram(flow).problems;
  assert.deepEqual(
    flowProblems.map((p) => `${p.kind}: ${p.labelId} × ${p.other}`),
    [],
    `画面遷移図の配置検査に誤検出: ${JSON.stringify(flowProblems)}`
  );

  // 検査そのものは生きている: 実体ノードの上を走る線ラベルは引き続き指摘する。
  const crossing = `
<mxfile><diagram name="交差"><mxGraphModel><root>
  <mxCell id="0" />
  <mxCell id="1" parent="0" />
  <mxCell id="src" value="src" style="rounded=0;html=1;whiteSpace=wrap;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
    <mxGeometry x="20" y="140" width="60" height="40" as="geometry" />
  </mxCell>
  <mxCell id="dst" value="dst" style="rounded=0;html=1;whiteSpace=wrap;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
    <mxGeometry x="520" y="140" width="60" height="40" as="geometry" />
  </mxCell>
  <mxCell id="box" value="ボックス" style="rounded=0;html=1;whiteSpace=wrap;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
    <mxGeometry x="200" y="130" width="120" height="60" as="geometry" />
  </mxCell>
  <mxCell id="e1" value="ラベルがボックス本体と重なる" style="edgeStyle=none;html=1;endArrow=block;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="src" target="dst">
    <mxGeometry relative="1" as="geometry" />
  </mxCell>
</root></mxGraphModel></diagram></mxfile>`;
  const crossingProblems = inspectDiagram(crossing).problems;
  assert.ok(
    crossingProblems.some((p) => p.kind === "ノード／ノートと文字の重なり" && p.other === "box"),
    `ノード本体と重なる線ラベルが指摘されなくなった（検査が効いていない）: ${JSON.stringify(crossingProblems)}`
  );
});

test("ドキュメント: ER の基数 7 値・配置指針・カタログのオプション記載が実装と一致する", () => {
  const erDoc = readText(path.join(ROOT, "references", "er.md"));
  assert.match(erDoc, /下限は常に `0`/);
  assert.match(erDoc, /"0\.\.1:0\.\.1"/, "ER の編集ガイドに 0..1:0..1 が選択肢として載っていません");
  assert.match(erDoc, /7 値/, "ER の基数は実装と同じ 7 値として説明されていません");

  const skill = readText(path.join(ROOT, "SKILL.md"));
  assert.match(skill, /画面 → API → DB/);
  assert.match(skill, /--extract-xml -o output\.drawio/);
  assert.match(skill, /<skill-dir>\/scripts\/drawio-cli\.mjs/, "SKILL はスキルフォルダへ cd せず絶対パスで呼ぶ手順になっていません");
  assert.match(skill, /docs\/diagrams\/er\.json/, "ER の 2 手順がユーザープロジェクト内の実在パスで説明されていません");
  assert.ok(!skill.includes("cd <スキルフォルダ>"), "SKILL にスキルフォルダへ cd する古い手順が残っています");

  const catalog = readText(path.join(ROOT, "references", "catalog-and-stencils.md"));
  assert.match(catalog, /`--no-png`.*class.*state.*c4.*screen-flow.*だけ/s, "--no-png の対応図種が正しく列挙されていません");
  assert.ok(
    !/--title[^\n]*--subtitle[^\n]*--no-png/.test(catalog),
    "カタログが --title / --subtitle / --no-png をまだ全サブコマンド共通とうたっていません"
  );

  const workflowDoc = readText(path.join(ROOT, "references", "workflow.md"));
  assert.match(workflowDoc, /\.\.\/examples\/workflow\/order-checkout-workflow\.json/);
  assert.ok(!workflowDoc.includes("](examples/"), "references/ 内から examples/ への相対リンクが壊れています");
});

test("NOTICE / README: resvg の wasm とグルコードの来歴が実装（同期化・組込み）と一致する", () => {
  const notice = readText(path.join(ROOT, "NOTICE"));
  assert.match(notice, /https:\/\/www\.mozilla\.org\/en-US\/MPL\/2\.0\//);
  assert.match(notice, /https:\/\/github\.com\/thx\/resvg-js\/tree\/v2\.6\.2/);
  assert.match(notice, /https:\/\/github\.com\/jgraph\/drawio\/tree\/v29\.6\.6/);
  assert.match(notice, /index_bg\.wasm/);
  assert.match(notice, /MODIFIED/);
  assert.match(notice, /__wbg_finalize_init/, "NOTICE が同期インスタンス化の改変実態を記述していません");

  const readme = readText(path.join(ROOT, "README.md"));
  assert.match(readme, /修正した版/, "README がグルコードを組み込む形に改変した事実を述べていません");
  assert.match(readme, /ローカルファイルの\s*import を一切持たない/, "README の単一ファイル完結の主張が実装と合わせて正確にされていません");
  assert.ok(
    !/グルーコード[\s\S]{0,80}改変せずそのまま/.test(readme),
    "README がまだグルコードを「改変せずそのまま」とうたっています"
  );
});

// ---------------------------------------------------------------------------
// 9. Codex Turn 3 レビューの High 指摘への回帰テスト
// ---------------------------------------------------------------------------

test("CLI: --json-out / --xml-out が入力ファイルと同一なら 1 バイトも書かずに exit(1)（ER / aws-arch / class）", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-overwrite-"));
  const cli = (script, args) =>
    spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
      encoding: "utf8",
      cwd: tmp,
    });
  try {
    // --- ER: --schema の SQL そのものを --json-out に指定 ---
    const sqlPath = path.join(tmp, "input.sql");
    const sqlBody = "CREATE TABLE users (\n  id BIGINT PRIMARY KEY\n);\n";
    await fs.writeFile(sqlPath, sqlBody, "utf8");
    const erXml = path.join(tmp, "er.drawio");
    const r1 = cli("build-er.mjs", [
      "--schema", sqlPath,
      "--json-out", sqlPath,
      "--xml-out", erXml,
      "-o", `${erXml}.png`,
    ]);
    assert.equal(r1.status, 1, `ER: exit 1 になりませんでした\n${r1.stdout}\n${r1.stderr}`);
    assert.match(r1.stderr, /--json-out/, `ER: エラーメッセージが出力先を指していません: ${r1.stderr}`);
    assert.equal(await fs.readFile(sqlPath, "utf8"), sqlBody, "ER: 入力 SQL が書き換えられています");
    assert.ok(!fsSync.existsSync(erXml), "ER: 検査前に .drawio へ書き込んでいます");

    // --- aws-arch: --tf-dir 配下の .tf を --json-out に指定 ---
    const tfDir = path.join(tmp, "tf");
    await fs.mkdir(tfDir, { recursive: true });
    const tfPath = path.join(tfDir, "main.tf");
    const tfBody = 'resource "aws_lambda_function" "w" {\n  function_name = "w"\n}\n';
    await fs.writeFile(tfPath, tfBody, "utf8");
    const awsXml = path.join(tmp, "aws.drawio");
    const r2 = cli("build-aws-arch.mjs", [
      tfDir,
      "--json-out", tfPath,
      "--xml-out", awsXml,
      "-o", `${awsXml}.png`,
    ]);
    assert.equal(r2.status, 1, `aws-arch: exit 1 になりませんでした\n${r2.stdout}\n${r2.stderr}`);
    assert.match(r2.stderr, /--json-out/, `aws-arch: エラーメッセージが出力先を指していません: ${r2.stderr}`);
    assert.equal(await fs.readFile(tfPath, "utf8"), tfBody, "aws-arch: 入力 .tf が書き換えられています");
    assert.ok(!fsSync.existsSync(awsXml), "aws-arch: 検査前に .drawio へ書き込んでいます");

    // --- class: --src-dir のソースファイルを --xml-out に指定 ---
    const srcDir = path.join(tmp, "src");
    await fs.mkdir(srcDir, { recursive: true });
    const tsPath = path.join(srcDir, "foo.ts");
    const tsBody = "export class Foo {\n  bar(): number {\n    return 1;\n  }\n}\n";
    await fs.writeFile(tsPath, tsBody, "utf8");
    const r3 = cli("build-class.mjs", ["--src-dir", srcDir, "--xml-out", tsPath, "--no-png"]);
    assert.equal(r3.status, 1, `class: exit 1 になりませんでした\n${r3.stdout}\n${r3.stderr}`);
    assert.match(r3.stderr, /--xml-out/, `class: エラーメッセージが出力先を指していません: ${r3.stderr}`);
    assert.equal(await fs.readFile(tsPath, "utf8"), tsBody, "class: 入力 .ts が書き換えられています");

    // --- 正常系: 別々の出力先なら従来どおり生成できる ---
    const okXml = path.join(tmp, "ok.drawio");
    const r4 = cli("build-er.mjs", [
      "--schema", sqlPath,
      "--xml-out", okXml,
      "-o", path.join(tmp, "ok.drawio.png"),
    ]);
    assert.equal(r4.status, 0, `ER(正常系): 生成に失敗しました\n${r4.stdout}\n${r4.stderr}`);
    assert.ok(fsSync.existsSync(okXml), "ER(正常系): .drawio が作られていません");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("scan-terraform: Task の Parameters.FunctionName だけを Invoke の根拠にし、JSON キーと入れ子 Task も拾う", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-sfn-"));
  const TF = `
resource "aws_lambda_function" "worker" {
  function_name = "worker"
}

resource "aws_lambda_function" "mailer" {
  function_name = "mailer"
}

resource "aws_sfn_state_machine" "hcl" {
  name = "hcl-style"
  definition = jsonencode({
    Comment = "Run は worker を呼ぶ。mailer は Payload 内に書くだけでは呼ばない"
    StartAt = "Run"
    States = {
      Run = {
        Type = "Task"
        Resource = aws_lambda_function.worker.arn
        Parameters = {
          FunctionName = aws_lambda_function.worker.function_name
          Payload = {
            FunctionName = aws_lambda_function.mailer.function_name
            Note       = "\${aws_lambda_function.mailer.arn}"
          }
        }
        End = true
      }
    }
  })
}

resource "aws_sfn_state_machine" "json" {
  name = "json-style"
  definition = jsonencode({
    "StartAt" : "Fan",
    "States" : {
      "Fan" : {
        "Type" : "Parallel",
        "Branches" : [
          { "Type" : "Task", "Resource" : "\${aws_lambda_function.worker.arn}", "End" : true },
          { "Type" : "Task", "Resource" : "\${aws_lambda_function.mailer.arn}", "End" : true }
        ],
        "Next" : "Done"
      },
      "Done" : {
        "Type" : "Pass",
        "Result" : { "arn" : "\${aws_lambda_function.mailer.arn}" },
        "End" : true
      }
    }
  })
}
`;
  try {
    await fs.writeFile(path.join(tmp, "main.tf"), TF, "utf8");
    const spec = await scanTerraformDirectory(tmp, {});
    const labelsFrom = (id) =>
      spec.edges.filter((e) => e.from === id).map((e) => `${e.to}=${e.label}`);

    const hcl = labelsFrom("aws_sfn_state_machine_hcl");
    assert.ok(
      hcl.includes("aws_lambda_function_worker=Invoke"),
      `HCL 表記の Task（Resource / Parameters.FunctionName）が Invoke になりません: ${hcl}`
    );
    assert.ok(
      !hcl.some((e) => e.startsWith("aws_lambda_function_mailer")),
      `Parameters.Payload.FunctionName が Invoke の根拠になっています: ${hcl}`
    );

    const json = labelsFrom("aws_sfn_state_machine_json");
    assert.ok(
      json.includes("aws_lambda_function_worker=Invoke"),
      `JSON キー表記（"Type": "Task" / "Resource": ...）が Invoke になりません: ${json}`
    );
    assert.ok(
      json.includes("aws_lambda_function_mailer=Invoke"),
      `Parallel の Branches に入れ子にした Task が拾えません: ${json}`
    );
    assert.equal(
      json.filter((e) => e.includes("mailer")).length,
      1,
      `Pass ステートの Result にある ARN が Invoke の根拠になっています: ${json}`
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("ワークフロー: レーン ID `team` とノード ID `lane_team` が衝突してもセル ID が重複しない（横・縦）", async () => {
  const spec = {
    title: "セル ID 衝突検査",
    subtitle: "レーン team とノード lane_team",
    lanes: [
      { id: "team", title: "チーム", subtitle: "レーン ID = team" },
      { id: "ui", title: "UI", subtitle: "" },
    ],
    phases: [{ label: "手順 1", fromCol: 0, toCol: 1 }],
    nodes: [
      { id: "lane_team", lane: "team", col: 0, label: "ノード ID が lane_team", effect: "効果 A" },
      { id: "n2", lane: "ui", col: 1, label: "UI ノード", effect: "効果 B" },
    ],
    edges: [
      { id: "edge_1", from: "lane_team", to: "n2", label: "1 本目" },
      // ラベル子セル `<edgeId>_lbl` と名前が衝突しうる ID
      { id: "edge_1_lbl", from: "lane_team", to: "n2", label: "2 本目" },
    ],
  };

  for (const direction of ["horizontal", "vertical"]) {
    const label = `workflow/cell-id-collision/${direction}`;
    const xml = generateWorkflowDrawioXml({ ...spec, direction });
    // 二重 ID・親／source／target の未解決・生 & を一括検査し、実パーサーでも通す
    const doc = await assertWellFormed(xml, label);

    const cells = [...doc.getElementsByTagName("mxCell")];
    const byValue = (text) => cells.filter((c) => (c.getAttribute("value") || "").includes(text));
    const laneCells = cells.filter((c) => (c.getAttribute("style") || "").includes("swimlane;"));
    const teamLane = laneCells.find((c) => /(^|[-_~])team$/.test(c.getAttribute("id") || ""));
    const nodeCell = byValue("ノード ID が lane_team")[0];
    assert.ok(teamLane && nodeCell, `${label}: レーンセルまたはノードセルが見つかりません`);
    assert.notEqual(
      teamLane.getAttribute("id"),
      nodeCell.getAttribute("id"),
      `${label}: レーンセルとノードセルの ID が同一です`
    );
    assert.notEqual(
      nodeCell.getAttribute("id"),
      "lane_team",
      `${label}: ノード ID が予約済みのレーンセル名と取り違えています`
    );
    // エッジ 2 本の source / target がノードセルの実際の ID に解決できていること
    const nodeIds = new Set([nodeCell.getAttribute("id"), ...byValue("UI ノード").map((c) => c.getAttribute("id"))]);
    const edges = cells.filter((c) => c.getAttribute("edge") === "1");
    assert.equal(edges.length, 2, `${label}: エッジが 2 本描かれていません`);
    for (const e of edges) {
      assert.ok(nodeIds.has(e.getAttribute("source")), `${label}: エッジの source がノードセルに解決できません`);
      assert.ok(nodeIds.has(e.getAttribute("target")), `${label}: エッジの target がノードセルに解決できません`);
    }
  }
});

test("drawio2png.mjs / NOTICE / README: ファイル全体の MPL-2.0 と Source Code Form の所在が 3 文書で一致する", () => {
  const src = readText(path.join(ROOT, "scripts", "drawio2png.mjs"));
  const notice = readText(path.join(ROOT, "NOTICE"));
  const readme = readText(path.join(ROOT, "README.md"));
  const BEGIN = "// BEGIN MPL-2.0 UPSTREAM CODE (@resvg/resvg-wasm v2.6.2)";
  const END = "// END MPL-2.0 UPSTREAM CODE (@resvg/resvg-wasm v2.6.2)";

  // 1) ヘッダが「ファイル全体 = MPL-2.0」をうたっている（部分適用の言い訳を残さない）
  const header = src.slice(0, src.indexOf("\n */\n") + 5);
  assert.ok(header.length > 200, "ライセンスヘッダが見つかりません");
  // ヘッダは行頭 " * " で折り返されているので、1 行につないだ本文として検査する
  const headerText = header.replace(/\r/g, "").replace(/\n \* /g, " ");
  assert.match(headerText, /THIS ENTIRE FILE IS DISTRIBUTED UNDER THE MPL-2\.0/);
  assert.match(headerText, /MPL-2\.0 works file by/);
  assert.match(headerText, /section 1\.4/);
  assert.match(headerText, /section 1\.10\(b\)/);
  assert.match(headerText, /section 1\.13/);
  assert.match(headerText, /section 3\.1/);
  assert.match(headerText, /section 3\.2/);
  assert.ok(!/1\.12/.test(headerText), "drawio2png.mjs ヘッダに古い §1.12 誤記が残っています");
  assert.match(
    header,
    /Comment markers inside[\s\S]{0,140}cannot carve out a narrower Covered Work/,
    "コメントマーカーで対象領域を絞る旧発想に戻っています"
  );

  // 2) Source Code Form = JS 本体・修正済みグルーはこのファイル自体、未改変 WASM (Executable Form) の Rust/WASM ソースは上流 URL
  assert.match(headerText, /WHERE THE SOURCE CODE FORM IS/);
  assert.match(headerText, /Source Code Form of the converter and the[\s\S]{0,40}modified glue/);
  assert.match(headerText, /unobfuscated,[\s\S]{0,20}uncompressed JavaScript/);
  assert.match(headerText, /Executable Form[\s\S]{0,80}MPL-2\.0 section 3\.2/);
  assert.match(headerText, /https:\/\/www\.mozilla\.org\/en-US\/MPL\/2\.0\//);

  // 3) 内包する第三者資産の帰属（draw.io Apache-2.0 / resvg MPL-2.0 / Atlassian / 商標）
  assert.match(headerText, /https:\/\/github\.com\/jgraph\/drawio\/tree\/v29\.6\.6/);
  assert.match(headerText, /https:\/\/github\.com\/thx\/resvg-js\/tree\/v2\.6\.2/);
  assert.match(headerText, /Apache License, Version 2\.0/);
  assert.match(headerText, /Atlassian products/);
  assert.match(headerText, /registered EU trademark \(#018062448\)/);

  // 4) Larger Work（§1.7 / §3.3）と、残りのファイルが Apache-2.0 であることの明記
  assert.match(headerText, /sections 1\.7 \/ 3\.3/);
  assert.match(headerText, /Larger Work/);
  assert.match(headerText, /licensed under the Apache License, Version/);
  for (const f of [
    "scripts/build-*.mjs",
    "scripts/scan-*.mjs",
    "scripts/drawio-cli.mjs",
    "scripts/diagram-shared.mjs",
    "scripts/check-layout.mjs",
    "SKILL.md",
    "references/",
    "examples/",
    "tests/",
  ]) {
    assert.ok(header.includes(f), `Larger Work を構成するファイル列挙に ${f} がありません`);
  }

  // 5) 来歴マーカーは 2 組対で、どちらも「ライセンスの境界ではない」と明記している
  const code = src.slice(header.length);
  const regions = code.split(BEGIN).slice(1).map((chunk) => chunk.split(END)[0]);
  assert.equal(regions.length, code.split(END).length - 1, "来歴マーカーの BEGIN / END が対になっていません");
  assert.equal(regions.length, 2, "来歴マーカーは wasm の base64 と JS グルーの 2 組のはずです");
  assert.ok(regions[0].includes("EMBEDDED_RESVG_WASM_B64"), "wasm の base64 が来歴マーカーで囲まれていません");
  assert.ok(
    regions[1].includes("__wbg_finalize_init") && regions[1].includes("isCustomFontsOptions"),
    "同期初期化へ対応済みの JS グルーが来歴マーカーで囲まれていません"
  );
  assert.ok(
    !regions.some((r) => r.includes("EMBEDDED_SHAPES_B64") || r.includes("EMBEDDED_STENCILS_MAP")),
    "draw.io 資産の塊が resvg の来歴マーカーに巻き込まれています"
  );
  for (const chunk of code.split(BEGIN).slice(1)) {
    assert.match(chunk.slice(0, 500), /NOT a license boundary/, "来歴マーカーの「境界ではない」注記がありません");
  }
  // マーカーの外側（このファイルの残り全部）も MPL-2.0 なので、変換コードが外にあっても矛盾しない
  assert.ok(code.slice(code.lastIndexOf(END)).includes("__getResvgRenderer"));

  // 6) 部分適用時代の記述（「その領域だけ MPL-2.0」）が 3 文書のどこにも残っていない
  for (const [name, text] of [
    ["scripts/drawio2png.mjs", src],
    ["NOTICE", notice],
    ["README.md", readme],
  ]) {
    assert.ok(!/MPL-2\.0 COVERED SOFTWARE/.test(text), `${name} に旧マーカー名が残っています`);
    assert.ok(
      !/この領域だけ MPL-2\.0|この部分だけ MPL-2\.0/.test(text),
      `${name} に部分適用の記述が残っています`
    );
  }

  // 7) NOTICE も「ファイル全体」の立場で §1.4 / §1.7 / §1.10(b) / §1.13 / §3.1 / §3.2 / §3.3 を挙げている
  assert.match(notice, /AS A WHOLE FILE, under the Mozilla Public License/);
  assert.match(notice, /section 1\.4/);
  assert.match(notice, /section 1\.10\(b\)/);
  assert.match(notice, /section 1\.13/);
  assert.match(notice, /section 3\.1/);
  assert.match(notice, /section 3\.2/);
  assert.match(notice, /section 3\.3/);
  assert.match(notice, /sections 1\.7 and 3\.3/);
  assert.ok(!/\b1\.12\b/.test(notice), "NOTICE に古い §1.12 誤記が残っています");
  assert.match(notice, /provenance notes only/);
  assert.match(notice, /WHERE THE SOURCE CODE FORM IS/);
  assert.match(notice, /is itself the Source Code Form/);
  assert.match(notice, /Executable Form[\s\S]{0,200}MPL-2\.0 section 3\.2/);
  assert.match(notice, /Larger Work/);
  assert.match(notice, /https:\/\/github\.com\/thx\/resvg-js\/tree\/v2\.6\.2/);
  assert.match(notice, /https:\/\/github\.com\/jgraph\/drawio\/tree\/v29\.6\.6/);
  assert.match(notice, /https:\/\/www\.mozilla\.org\/en-US\/MPL\/2\.0\//);
  assert.match(notice, /Atlassian products/);
  assert.match(notice, /registered EU trademark \(#018062448\)/);
  assert.ok(
    !/corresponding Source Code Form remains available upstream/.test(notice),
    "NOTICE が修正版の Source Code Form を上流依存だけと書いています"
  );

  // 8) README の表と説明も「ファイル全体 = MPL-2.0」「§1.4 / §1.7 / §1.13 / §3.2」「来歴メモ」に揃えている
  assert.match(readme, /\*\*MPL-2\.0\*\*（ファイル全体）/);
  assert.match(readme, /MPL-2\.0 はファイル単位で適用される/);
  assert.match(readme, /§1\.7 \/ §3\.3 がいう \*\*Larger Work\*\*/);
  assert.match(readme, /§1\.4・§1\.10\(b\)・§3\.1・§3\.2・§3\.3/);
  assert.match(readme, /§1\.13/);
  assert.ok(!/§1\.12/.test(readme), "README に古い §1.12 誤記が残っています");
  assert.match(readme, /MPL-2\.0 UPSTREAM CODE/);
  assert.match(readme, /\*\*来歴メモ\*\*/);
  assert.match(readme, /ライセンスの境界ではありません/);
  assert.match(readme, /そのものが Source Code Form です/);
  assert.match(readme, /Executable Form[\s\S]{0,160}MPL-2\.0 §3\.2/);
  assert.ok(
    !/Source Code Form は\s*上の来歴 URL に公開/.test(readme),
    "README が修正版の Source Code Form を上流 URL のみに公開している記述に戻っています"
  );
});

// ---------------------------------------------------------------------------
// 10. Codex Turn 4 レビューの High / Medium 指摘への回帰テスト
// ---------------------------------------------------------------------------

/** そのファイルシステムが大文字小文字を区別しないかを実測する（macOS / Windows 前提の検査を絞る） */
function probeCaseInsensitiveFs(dir) {
  const probe = path.join(dir, "CaseProbe.TXT");
  fsSync.writeFileSync(probe, "x");
  try {
    return fsSync.existsSync(path.join(dir, "caseprobe.txt"));
  } finally {
    fsSync.rmSync(probe, { force: true });
  }
}

/** symlink を作れる環境か（作れなければ false を返し、その検査だけ飛ばす） */
async function trySymlink(target, linkPath) {
  try {
    await fs.symlink(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

const MINIMAL_DRAWIO = `<mxfile host="app" version="test">
  <diagram id="p1" name="Page-1">
    <mxGraphModel dx="800" dy="600" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="400" pageHeight="200" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="n1" value="Self overwrite" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="40" y="40" width="160" height="60" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;

const runScript = (script, args, cwd) =>
  spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    encoding: "utf8",
    cwd,
    timeout: 180000,
  });

test("High 2: out/ 配下の実走査ファイルを大文字小文字違い・symlink の別名で --json-out 指定しても exit(1)", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-identity-"));
  try {
    // スキャナが実際に見るファイルを out/ の下に置く（昔は照合だけが out を飛ばしていた）
    const real = path.join(tmp, "proj", "out", "ecommerce.sql");
    await fs.mkdir(path.dirname(real), { recursive: true });
    const sqlBody =
      "CREATE TABLE orders (\n  id BIGINT PRIMARY KEY,\n  total INTEGER NOT NULL\n);\n";
    await fs.writeFile(real, sqlBody, "utf8");
    const xml = path.join(tmp, "er.drawio");

    const aliases = [];
    if (probeCaseInsensitiveFs(path.dirname(real))) {
      aliases.push(["大文字小文字違い", path.join(tmp, "proj", "out", "ECOMMERCE.SQL")]);
    }
    const link = path.join(tmp, "latest.sql");
    if (await trySymlink(real, link)) aliases.push(["symlink", link]);
    if (aliases.length === 0) {
      t.skip("大文字小文字同一視も symlink 作成もできない環境のためスキップ");
      return;
    }

    for (const [label, alias] of aliases) {
      const r = runScript(
        "build-er.mjs",
        ["--schema", path.join(tmp, "proj"), "--json-out", alias, "--xml-out", xml, "-o", `${xml}.png`],
        tmp
      );
      assert.equal(r.status, 1, `${label}の別名指定が exit(1) になりませんでした:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /--json-out/, `${label}: どちらの出力先が原因か出ていません: ${r.stderr}`);
      assert.match(r.stderr, /ecommerce\.sql/, `${label}: 実際に走査した入力名が示されていません: ${r.stderr}`);
      assert.equal(await fs.readFile(real, "utf8"), sqlBody, `${label}: 入力 SQL が書き換えられています`);
      assert.ok(!fsSync.existsSync(xml), `${label}: 検査前に .drawio / PNG を作っています`);
    }

    // 別名の検査は「実走査した一覧」を見ているので、out/ 配下でも守られる
    const okXml = path.join(tmp, "ok.drawio");
    const okRun = runScript(
      "build-er.mjs",
      ["--schema", path.join(tmp, "proj"), "--json-out", path.join(tmp, "ok.json"), "--xml-out", okXml, "-o", path.join(tmp, "ok.png")],
      tmp
    );
    assert.equal(okRun.status, 0, `別名指定のない生成が失敗しました:\n${okRun.stdout}\n${okRun.stderr}`);
    assert.match(await fs.readFile(path.join(tmp, "ok.json"), "utf8"), /orders/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("High 3: scan-schema / scan-terraform / scan-classes は -o に入力を指定したら exit(1) で入力は無傷", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-scancli-"));
  try {
    // --- scan-schema: 位置引数の SQL そのものへ -o ---
    const sql = path.join(tmp, "schema.sql");
    const sqlBody = "CREATE TABLE users (\n  id BIGINT PRIMARY KEY\n);\n";
    await fs.writeFile(sql, sqlBody, "utf8");
    const r1 = runScript("scan-schema.mjs", [sql, "-o", sql], tmp);
    assert.equal(r1.status, 1, `scan-schema: exit(1) になりません\n${r1.stdout}\n${r1.stderr}`);
    assert.match(r1.stderr, /--output/, `scan-schema: 出力先の役割が出ていません: ${r1.stderr}`);
    assert.equal(await fs.readFile(sql, "utf8"), sqlBody, "scan-schema: 入力 SQL が書き換えられています");

    // --- scan-terraform: --tf-dir 配下（ディレクトリ指定でも実走査ファイル）へ -o ---
    const tfDir = path.join(tmp, "tf");
    await fs.mkdir(tfDir, { recursive: true });
    const tf = path.join(tfDir, "main.tf");
    const tfBody = 'resource "aws_lambda_function" "a" {\n  function_name = "a"\n}\n';
    await fs.writeFile(tf, tfBody, "utf8");
    const r2 = runScript("scan-terraform.mjs", ["--tf-dir", tfDir, "-o", tf], tmp);
    assert.equal(r2.status, 1, `scan-terraform: exit(1) になりません\n${r2.stdout}\n${r2.stderr}`);
    assert.match(r2.stderr, /--output/, `scan-terraform: 出力先の役割が出ていません: ${r2.stderr}`);
    assert.equal(await fs.readFile(tf, "utf8"), tfBody, "scan-terraform: 入力 .tf が書き換えられています");

    // --- scan-classes: --src-dir 配下のソースへ -o（symlink 別名も含める） ---
    const srcDir = path.join(tmp, "src");
    await fs.mkdir(srcDir, { recursive: true });
    const ts = path.join(srcDir, "model.ts");
    const tsBody = "export class Model {\n  id: string = '';\n}\n";
    await fs.writeFile(ts, tsBody, "utf8");
    const tsAlias = path.join(srcDir, "alias.ts");
    const madeLink = await trySymlink(ts, tsAlias);
    const r3 = runScript("scan-classes.mjs", ["--src-dir", srcDir, "-o", madeLink ? tsAlias : ts], tmp);
    assert.equal(r3.status, 1, `scan-classes: exit(1) になりません\n${r3.stdout}\n${r3.stderr}`);
    assert.match(r3.stderr, /--output/, `scan-classes: 出力先の役割が出ていません: ${r3.stderr}`);
    assert.equal(await fs.readFile(ts, "utf8"), tsBody, "scan-classes: 入力 .ts が書き換えられています");
    if (madeLink) {
      const r3b = runScript("scan-classes.mjs", ["--src-dir", srcDir, "-o", ts], tmp);
      assert.equal(r3b.status, 1, `scan-classes（実パス指定）: exit(1) になりません\n${r3b.stderr}`);
    }

    // 正常系: 入力を含まない別ディレクトリへの -o は従来どおり動く
    const outJson = path.join(tmp, "out", "schema.json");
    const okRun = runScript("scan-schema.mjs", [sql, "-o", outJson], tmp);
    assert.equal(okRun.status, 0, `scan-schema(正常系): 失敗\n${okRun.stdout}\n${okRun.stderr}`);
    assert.ok(fsSync.existsSync(outJson), "scan-schema(正常系): JSON が作られていません");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("High 4: .drawio.png を png 変換の入力にすると、既定出力先・明示 -o・別名・--extract-xml すべて exit(1) で埋め込み XML は無傷", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-selfpng-"));
  try {
    const src = path.join(tmp, "diagram.drawio");
    await fs.writeFile(src, MINIMAL_DRAWIO, "utf8");
    const made = runScript("drawio2png.mjs", [src, "-o", path.join(tmp, "diagram.drawio.png")], tmp);
    assert.equal(made.status, 0, `.drawio.png の準備に失敗\n${made.stdout}\n${made.stderr}`);
    const png = path.join(tmp, "diagram.drawio.png");
    const original = fsSync.readFileSync(png);
    const embedded = extractDrawioXmlFromPng(original);
    assert.ok(embedded, "埋め込み XML が取り出せません（前提の PNG が作れていません）");

    const guards = [["既定出力先（-o なし）", ["diagram.drawio.png"]], ["明示 -o", ["diagram.drawio.png", "-o", "diagram.drawio.png"]]];
    if (probeCaseInsensitiveFs(tmp)) {
      guards.push(["大文字小文字違いの -o", ["diagram.drawio.png", "-o", "DIAGRAM.Drawio.PNG"]]);
    }
    if (await trySymlink(png, path.join(tmp, "latest.png"))) {
      guards.push(["symlink 別名への -o", ["diagram.drawio.png", "-o", "latest.png"]]);
    }
    for (const [label, args] of guards) {
      const r = runScript("drawio2png.mjs", args, tmp);
      assert.equal(r.status, 1, `${label}が exit(1) になりません\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /入力ファイルと同一/, `${label}: 理由がエラーメッセージに出ていません: ${r.stderr}`);
      assert.ok(fsSync.readFileSync(png).equals(original), `${label}: 変換前に入力を壊しています`);
      assert.equal(extractDrawioXmlFromPng(fsSync.readFileSync(png)), embedded, `${label}: 埋め込み XML が失われています`);
    }

    // --extract-xml の -o も入力を指したら止まる
    const rx = runScript("drawio2png.mjs", ["diagram.drawio.png", "--extract-xml", "-o", "diagram.drawio.png"], tmp);
    assert.equal(rx.status, 1, `--extract-xml の自己上書きが exit(1) になりません\n${rx.stdout}\n${rx.stderr}`);
    assert.ok(fsSync.readFileSync(png).equals(original), "--extract-xml 側で入力を壊しています");

    // --all-pages も既定出力先が自分自身なら止まる
    const ra = runScript("drawio2png.mjs", ["diagram.drawio.png", "--all-pages"], tmp);
    assert.equal(ra.status, 1, `--all-pages の自己上書きが exit(1) になりません\n${ra.stdout}\n${ra.stderr}`);
    assert.ok(fsSync.readFileSync(png).equals(original), "--all-pages 側で入力を壊しています");

    // 正常系: .drawio -> .png（既定名 / 明示名）と、別名の PNG への書き出しは今までどおり動く
    const ok1 = runScript("drawio2png.mjs", ["diagram.drawio"], tmp);
    assert.equal(ok1.status, 0, `.drawio -> .png(既定名) が失敗\n${ok1.stdout}\n${ok1.stderr}`);
    assert.ok(fsSync.existsSync(path.join(tmp, "diagram.png")), "diagram.png が作られていません");
    const ok2 = runScript("drawio2png.mjs", ["diagram.drawio.png", "-o", "copy.drawio.png"], tmp);
    assert.equal(ok2.status, 0, `別名の PNG への書き出しが失敗\n${ok2.stdout}\n${ok2.stderr}`);
    assert.ok(fsSync.existsSync(path.join(tmp, "copy.drawio.png")), "copy.drawio.png が作られていません");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("High 5: Pass の Result に Task の形を書いても Invoke 線は作らない（Parallel.Branches と Map.ItemProcessor は結ぶ）", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-pass-"));
  const TF = `
resource "aws_lambda_function" "worker" {
  function_name = "worker"
}

resource "aws_lambda_function" "mapper" {
  function_name = "mapper"
}

resource "aws_lambda_function" "mailer" {
  function_name = "mailer"
}

resource "aws_sfn_state_machine" "flow" {
  name = "flow"
  definition = jsonencode({
    "StartAt" : "Fan",
    "States" : {
      "Fan" : {
        "Type" : "Parallel",
        "Branches" : [
          { "Type" : "Task", "Resource" : "\${aws_lambda_function.worker.arn}", "End" : true }
        ],
        "Next" : "Each"
      },
      "Each" : {
        "Type" : "Map",
        "ItemProcessor" : {
          "StartAt" : "M",
          "States" : {
            "M" : { "Type" : "Task", "Resource" : "\${aws_lambda_function.mapper.arn}", "End" : true }
          }
        },
        "End" : true
      },
      "Quiet" : {
        "Type" : "Pass",
        "Result" : {
          "Type" : "Task",
          "Resource" : "\${aws_lambda_function.mailer.arn}",
          "Parameters" : { "FunctionName" : "\${aws_lambda_function.mailer.function_name}" }
        },
        "End" : true
      }
    }
  })
}
`;
  try {
    await fs.writeFile(path.join(tmp, "main.tf"), TF, "utf8");
    const spec = await scanTerraformDirectory(tmp, {});
    const targets = spec.edges
      .filter((e) => e.from === "aws_sfn_state_machine_flow")
      .map((e) => `${e.to}=${e.label}`);
    assert.ok(
      targets.includes("aws_lambda_function_worker=Invoke"),
      `Parallel.Branches の Task が結ばれません: ${targets}`
    );
    assert.ok(
      targets.includes("aws_lambda_function_mapper=Invoke"),
      `Map.ItemProcessor の Task が結ばれません: ${targets}`
    );
    assert.ok(
      !spec.edges.some((e) => e.to === "aws_lambda_function_mailer" || e.from === "aws_lambda_function_mailer"),
      `Pass の Result 内にある Task の形を執行の根拠にしています: ${JSON.stringify(spec.edges)}`
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("High 6: glue リソースは属性名で結び、depends_on は接続の根拠にしない", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-glue-"));
  const TF = `
resource "aws_apigatewayv2_api" "gw" {
  name = "gw"
}

resource "aws_lambda_function" "worker" {
  function_name = "worker"
}

resource "aws_lambda_function" "mailer" {
  function_name = "mailer"
}

resource "aws_apigatewayv2_integration" "to_worker" {
  api_id           = aws_apigatewayv2_api.gw.id
  integration_type = "AWS_PROXY"
  depends_on       = [aws_lambda_function.mailer]
  integration_uri  = aws_lambda_function.worker.invoke_arn
}
`;
  try {
    await fs.writeFile(path.join(tmp, "main.tf"), TF, "utf8");
    const spec = await scanTerraformDirectory(tmp, {});
    const edge = spec.edges.find(
      (e) => e.from === "aws_apigatewayv2_api_gw" && e.to === "aws_lambda_function_worker"
    );
    assert.ok(edge, `api_id + integration_uri から API -> Lambda の線が作れません: ${JSON.stringify(spec.edges)}`);
    assert.equal(edge.label, "Invoke");
    assert.ok(
      !spec.edges.some((e) => e.from === "aws_lambda_function_mailer" || e.to === "aws_lambda_function_mailer"),
      `depends_on の先が接続されています: ${JSON.stringify(spec.edges)}`
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium 2: 同名型が複数ファイルにあるとき、extends の親は相対 import 先の宣言で解決する", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-import-"));
  try {
    // a-legacy.ts が走査順で先に来るため、import を見ない実装はそちらを親に選ぶ
    await fs.writeFile(
      path.join(tmp, "a-legacy.ts"),
      "export class Base {\n  legacyOnly: string = '';\n}\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "b.ts"),
      "export class Base {\n  importOnly: string = '';\n}\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "impl.ts"),
      'import { Base } from "./b";\n\nexport class Impl extends Base {}\n',
      "utf8"
    );
    const spec = await scanDirectory(tmp, {});
    const rel = spec.relations.find((r) => r.from === "Impl" && r.type === "inheritance");
    assert.ok(rel, `Impl の inheritance が作れません: ${JSON.stringify(spec.relations)}`);
    const parent = spec.classes.find((c) => c.id === rel.to);
    assert.ok(parent, "親クラスが spec に見当たりません");
    assert.equal(parent.name, "Base (b.ts)", "import 先（b.ts）ではなく走査順で先の Base を親にしています");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium 1: writeFileAtomic は同じディレクトリの一時ファイルから rename し、失敗時も一時ファイルを残さない", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-atomic-"));
  try {
    const target = path.join(tmp, "out.json");
    await writeFileAtomic(target, '{"a":1}\n');
    assert.equal(await fs.readFile(target, "utf8"), '{"a":1}\n');
    assert.deepEqual(await fs.readdir(tmp), ["out.json"], "一時ファイルが残っています");

    // 既存ファイルの上書きも rename で置き換わる
    await writeFileAtomic(target, '{"a":2}\n');
    assert.equal(await fs.readFile(target, "utf8"), '{"a":2}\n');
    assert.deepEqual(await fs.readdir(tmp), ["out.json"], "上書き後に一時ファイルが残っています");

    // 書き込み先ディレクトリが無い場合は呼び出し側で mkdir する前提（エラーはそのまま伝える）
    await assert.rejects(() => writeFileAtomic(path.join(tmp, "missing", "x.json"), "x"));
    assert.deepEqual(await fs.readdir(tmp), ["out.json"], "失敗時に一時ファイルが残っています");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
// 11. Codex Turn 5 レビューの High / Medium 指摘への回帰テスト
// ---------------------------------------------------------------------------

/** 生パス表記を崩さず成分を連結する（path.join は `..` を字句で折畳んでしまうため）。 */
const rawJoin = (...parts) => parts.join(path.sep);

test("High: symlink を跨ぐ `..` 表記の出力先も exit(1)。実体は無傷で、正当な別名出力は通る", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-dotdot-"));
  try {
    // `link` が別階層（sub1/sub2）へのディレクトリ symlink なので、
    // `link/..` は OS に解決させると `sub1` になる（path.resolve は `link` を潰して `tmp` にする）
    await fs.mkdir(path.join(tmp, "sub1", "sub2"), { recursive: true });
    const link = path.join(tmp, "link");
    const madeLink = await trySymlink(path.join("sub1", "sub2"), link);
    if (!madeLink) {
      t.skip("symlink を作成できない環境のためスキップ");
      return;
    }

    // --- ER: `link/../target.sql` を --json-out に指定（実は sub1/target.sql そのもの） ---
    const sqlReal = path.join(tmp, "sub1", "target.sql");
    const sqlBody = "CREATE TABLE orders (\n  id BIGINT PRIMARY KEY,\n  total INTEGER NOT NULL\n);\n";
    await fs.writeFile(sqlReal, sqlBody, "utf8");
    const erXml = path.join(tmp, "er.drawio");
    const dotDotSql = rawJoin("link", "..", "target.sql");
    const erRun = runScript(
      "build-er.mjs",
      ["--schema", tmp, "--json-out", dotDotSql, "--xml-out", erXml, "-o", `${erXml}.png`],
      tmp
    );
    assert.equal(erRun.status, 1, `link/../target.sql が exit(1) になりません:\n${erRun.stdout}\n${erRun.stderr}`);
    assert.match(erRun.stderr, /--json-out/, `どちらの出力先が原因か出ていません: ${erRun.stderr}`);
    assert.match(erRun.stderr, /target\.sql/, `衝突した入力名が示されていません: ${erRun.stderr}`);
    assert.equal(await fs.readFile(sqlReal, "utf8"), sqlBody, "入力 SQL が書き換えられています");
    assert.ok(!fsSync.existsSync(erXml), "検査前に .drawio / PNG を作っています");

    // --- drawio2png: `link/../diagram.drawio.png` を -o に指定（入力 PNG そのもの） ---
    const drawio = path.join(tmp, "sub1", "diagram.drawio");
    await fs.writeFile(drawio, MINIMAL_DRAWIO, "utf8");
    const made = runScript(
      "drawio2png.mjs",
      [rawJoin("sub1", "diagram.drawio"), "-o", rawJoin("sub1", "diagram.drawio.png")],
      tmp
    );
    assert.equal(made.status, 0, `.drawio.png の準備に失敗\n${made.stdout}\n${made.stderr}`);
    const pngReal = path.join(tmp, "sub1", "diagram.drawio.png");
    const original = fsSync.readFileSync(pngReal);
    const embedded = extractDrawioXmlFromPng(original);
    assert.ok(embedded, "埋め込み XML が取り出せません（前提の PNG が作れていません）");

    const dotDotPng = rawJoin("link", "..", "diagram.drawio.png");
    for (const [label, args] of [
      ["実パスを入力 / `..` 別名を出力", [rawJoin("sub1", "diagram.drawio.png"), "-o", dotDotPng]],
      ["`..` 別名を入力 / 実パスを出力", [dotDotPng, "-o", rawJoin("sub1", "diagram.drawio.png")]],
      ["`..` 別名どうし（-o なしの既定出力先）", [dotDotPng]],
    ]) {
      const r = runScript("drawio2png.mjs", args, tmp);
      assert.equal(r.status, 1, `${label} が exit(1) になりません\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /入力ファイルと同一/, `${label}: 理由がエラーメッセージに出ていません: ${r.stderr}`);
      assert.ok(fsSync.readFileSync(pngReal).equals(original), `${label}: 変換前に入力を壊しています`);
      assert.equal(
        extractDrawioXmlFromPng(fsSync.readFileSync(pngReal)),
        embedded,
        `${label}: 埋め込み XML が失われています`
      );
    }

    // --extract-xml の -o も `..` 別名なら同じ実体として弾ける
    const rx = runScript(
      "drawio2png.mjs",
      [rawJoin("sub1", "diagram.drawio.png"), "--extract-xml", "-o", dotDotPng],
      tmp
    );
    assert.equal(rx.status, 1, `--extract-xml の .. 別名指定が exit(1) になりません\n${rx.stderr}`);
    assert.ok(fsSync.readFileSync(pngReal).equals(original), "--extract-xml 側で入力を壊しています");

    // 正常系: 同じ `..` 表記でも別ファイルへの出力は従来どおり通る（過剰検出の防止）
    const okRun = runScript(
      "drawio2png.mjs",
      [rawJoin("sub1", "diagram.drawio"), "-o", rawJoin("link", "..", "copy.drawio.png")],
      tmp
    );
    assert.equal(okRun.status, 0, `別名ディレクトリ経由の正常系が失敗\n${okRun.stdout}\n${okRun.stderr}`);
    assert.ok(
      fsSync.existsSync(path.join(tmp, "sub1", "copy.drawio.png")),
      "`link/../copy.drawio.png` が symlink を辿った先（sub1/）に作られていません"
    );
    const erOk = runScript(
      "build-er.mjs",
      [
        "--schema", tmp,
        "--json-out", rawJoin("link", "..", "sub2", "er.json"),
        "--xml-out", rawJoin("link", "..", "sub2", "er.drawio"),
        "-o", rawJoin("link", "..", "sub2", "er.drawio.png"),
      ],
      tmp
    );
    assert.equal(erOk.status, 0, `正常系（ER / .. 経由の別名出力）が失敗\n${erOk.stdout}\n${erOk.stderr}`);
    assert.ok(fsSync.existsSync(path.join(tmp, "sub1", "sub2", "er.json")), "er.json が作られていません");
    assert.deepEqual(await fs.readFile(sqlReal, "utf8"), sqlBody, "正常系で入力 SQL が書き換わっています");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("High: writeFileAtomic は予測可能な .tmp-<pid> を一切触らず、同一 target への並行書き込みも安全", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-atomic2-"));
  try {
    const target = path.join(tmp, "out.json");
    // 旧実装が使っていた予測可能な一時ファイル名を、中身入りの他人ファイルとして用意する
    const decoy = `${target}.tmp-${process.pid}`;
    const decoyBody = "PRE-EXISTING DECOY";
    await fs.writeFile(decoy, decoyBody, "utf8");

    await writeFileAtomic(target, "new\n");
    assert.equal(await fs.readFile(target, "utf8"), "new\n", "本体が更新されていません");
    assert.equal(await fs.readFile(decoy, "utf8"), decoyBody, "既存の .tmp-<pid> が上書き・切り詰められています");

    // 別名（別 pid 風）の一時ファイルも同様に無傷
    const other = `${target}.tmp-999999`;
    await fs.writeFile(other, decoyBody, "utf8");
    await writeFileAtomic(target, "new2\n");
    assert.equal(await fs.readFile(other, "utf8"), decoyBody, "既存の .tmp-* が消えています");

    // 一時ファイルの残骸は 0（decoy 2 つと本体だけ）
    assert.deepEqual(
      (await fs.readdir(tmp)).sort(),
      [path.basename(decoy), path.basename(other), "out.json"].sort(),
      "一時ファイルが残っています"
    );

    // 同一プロセス内から同じ target へ並行実行しても取り残し・エラーなし
    const payloads = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
    await Promise.all(payloads.map((p) => writeFileAtomic(target, p)));
    assert.ok(payloads.includes(await fs.readFile(target, "utf8")), "並行書き込みの結果がどれとも一致しません");
    assert.deepEqual(
      (await fs.readdir(tmp)).sort(),
      [path.basename(decoy), path.basename(other), "out.json"].sort(),
      "並行書き込み後に一時ファイルが残っています"
    );
    assert.equal(await fs.readFile(decoy, "utf8"), decoyBody, "並行書き込みで .tmp-<pid> を触っています");

    // 失敗時（親ディレクトリが無い）も自分の一時ファイルを置き去りにせず、decoy にも触れない
    await assert.rejects(() => writeFileAtomic(path.join(tmp, "missing", "x.json"), "x"));
    assert.deepEqual(
      (await fs.readdir(tmp)).sort(),
      [path.basename(decoy), path.basename(other), "out.json"].sort(),
      "失敗時に一時ファイルが残っています"
    );
    assert.equal(await fs.readFile(decoy, "utf8"), decoyBody, "失敗時に .tmp-<pid> を触っています");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: クラススキャナはシンボル単位の import で親を解決する（Helper だけ import した a.ts の Base を選ばない）", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-importsym-"));
  try {
    await fs.writeFile(
      path.join(tmp, "a.ts"),
      "export class Helper {}\n\nexport class Base {\n  fromA: string = '';\n}\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "b.ts"),
      "export class Base {\n  fromB: string = '';\n}\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "c.ts"),
      'import { Helper } from "./a";\nimport { Base } from "./b";\n\nexport class Child extends Base {}\n',
      "utf8"
    );
    const spec = await scanDirectory(tmp, {});
    const rel = spec.relations.find((r) => r.from === "Child" && r.type === "inheritance");
    assert.ok(rel, `Child の inheritance が作れません: ${JSON.stringify(spec.relations)}`);
    const parent = spec.classes.find((c) => c.id === rel.to);
    assert.ok(parent, "親クラスが spec に見当たりません");
    assert.equal(parent.name, "Base (b.ts)", "import 元（b.ts）ではなく Helper を import した a.ts の Base を親にしています");
    assert.equal(
      spec.relations.filter((r) => r.from === "Child").length,
      1,
      `Child の親が複数結ばれています: ${JSON.stringify(spec.relations)}`
    );

    // `import { Base as Parent }` の別名 import も同じ規則で解決する
    await fs.writeFile(
      path.join(tmp, "d.ts"),
      'import { Base as Parent } from "./a";\n\nexport class AliasChild extends Parent {}\n',
      "utf8"
    );
    const spec2 = await scanDirectory(tmp, {});
    const rel2 = spec2.relations.find((r) => r.from === "AliasChild" && r.type === "inheritance");
    assert.ok(rel2, `AliasChild の inheritance が作れません: ${JSON.stringify(spec2.relations)}`);
    const parent2 = spec2.classes.find((c) => c.id === rel2.to);
    assert.equal(parent2.name, "Base", "別名 import（a.ts の Base）が解決されていません");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("High: POSIX ではバックスラッシュ付きファイル名をディレクトリ区切りに分割しない", async () => {
  if (process.platform === "win32") return;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-bslash-"));
  try {
    const realTmp = await fs.realpath(tmp);
    const nameWithSlash = "example\\diagram.svg";
    const target = path.join(tmp, nameWithSlash);
    const resolved = resolveWriteTarget(target);
    assert.equal(resolved, path.join(realTmp, nameWithSlash));

    // 単体コンバーターもバックスラッシュをディレクトリ扱いせず直下に書く（別フォルダ example/ に逃げない）
    const xmlIn = path.join(tmp, "in.drawio");
    await fs.writeFile(
      xmlIn,
      '<mxfile><diagram id="d1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="n1" value="ok" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="20" y="20" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>',
      "utf8"
    );
    const r = cli(["png", xmlIn, "-o", target]);
    assert.equal(r.status, 0, r.stderr);
    const entries = await fs.readdir(tmp);
    assert.ok(entries.includes(nameWithSlash), `ファイル名が分割されました: ${JSON.stringify(entries)}`);
    assert.ok(!entries.includes("example"), "example ディレクトリが誤って作られました");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: symlink/../newdir/out.json のように実体側の親が未作成でも出力ディレクトリを正しく作る", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-symlink-mkdir-"));
  try {
    const sub1 = path.join(tmp, "sub1");
    const sub2 = path.join(sub1, "sub2");
    await fs.mkdir(sub2, { recursive: true });
    if (!(await trySymlink(sub2, path.join(tmp, "link")))) {
      t.skip("symlink を作成できない環境のためスキップ");
      return;
    }

    const sql = path.join(tmp, "schema.sql");
    await fs.writeFile(sql, "CREATE TABLE users (id int PRIMARY KEY);\n", "utf8");

    // path.join() は字句的に "link/.." を潰してしまうため、生の文字列で渡す
    const jsonOut = `${tmp}${path.sep}link${path.sep}..${path.sep}newdir${path.sep}result.json`;
    const pngOut = `${tmp}${path.sep}link${path.sep}..${path.sep}newdir${path.sep}er.drawio.png`;
    const r = cli(["er", "--schema", sql, "--json-out", jsonOut, "-o", pngOut]);
    assert.equal(r.status, 0, r.stderr);

    const realJson = path.join(sub1, "newdir", "result.json");
    const realPng = path.join(sub1, "newdir", "er.drawio.png");
    assert.ok(fsSync.existsSync(realJson), "symlink 先の親 sub1/newdir/result.json が作られていません");
    assert.ok(fsSync.existsSync(realPng), "symlink 先の親 sub1/newdir/er.drawio.png が作られていません");
    assert.equal(fsSync.existsSync(path.join(tmp, "newdir")), false, "字句折畳み側の誤ったディレクトリが作られました");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: 同一ファイルに親クラスがあるとき、他シンボルを import した別モジュールの同名クラスに負けない", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-samefile-"));
  try {
    await fs.writeFile(
      path.join(tmp, "a.ts"),
      "export class Helper {}\nexport class Base { fromA: string = ''; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "c.ts"),
      'import { Helper } from "./a";\nexport class Base { fromC: string = ""; }\nexport class Child extends Base {}\n',
      "utf8"
    );
    const spec = await scanDirectory(tmp, {});
    const child = spec.classes.find((c) => c.name === "Child");
    assert.ok(child);
    const rel = spec.relations.find((r) => r.from === child.id && r.type === "inheritance");
    assert.ok(rel, `inheritance がありません: ${JSON.stringify(spec.relations)}`);
    const parent = spec.classes.find((c) => c.id === rel.to);
    assert.equal(parent.name, "Base (c.ts)", `同一ファイルの Base ではなく ${parent.name} に結ばれました`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: export default class と名前を変えた default import でも継承線が落ちない", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-default-import-"));
  try {
    await fs.writeFile(
      path.join(tmp, "a.ts"),
      "export default class Base { aProp: string = ''; }\nexport class Helper {}\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "b.ts"),
      "export class Other {}\nexport default class Base { bProp: string = ''; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "c.ts"),
      'import Parent from "./b";\nexport class Child extends Parent {}\n',
      "utf8"
    );
    const spec = await scanDirectory(tmp, {});
    const child = spec.classes.find((c) => c.name === "Child");
    assert.ok(child);
    const rel = spec.relations.find((r) => r.from === child.id && r.type === "inheritance");
    assert.ok(rel, `別名 default import の inheritance が欠落しています: ${JSON.stringify(spec.relations)}`);
    const parent = spec.classes.find((c) => c.id === rel.to);
    assert.equal(parent.name, "Base (b.ts)", `b.ts の default export ではなく ${parent.name} が選ばれました`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: findImportedSymbol は識別子の大文字小文字を厳密に区別する (Base as base がローカル Base を隠さない)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-case-ident-"));
  try {
    await fs.writeFile(
      path.join(tmp, "a.ts"),
      "export class Base { fromA: string = ''; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "c.ts"),
      'import { Base as base } from "./a";\nexport class Base { fromC: string = ""; }\nexport class Child extends Base {}\n',
      "utf8"
    );
    const spec = await scanDirectory(tmp, {});
    const child = spec.classes.find((c) => c.name === "Child");
    assert.ok(child);
    const rel = spec.relations.find((r) => r.from === child.id && r.type === "inheritance");
    assert.ok(rel, `inheritance がありません: ${JSON.stringify(spec.relations)}`);
    const parent = spec.classes.find((c) => c.id === rel.to);
    assert.equal(parent.name, "Base (c.ts)", `import { Base as base } により別ファイル ${parent.name} が選ばれました`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: 文字列・テンプレートリテラル内の疑似 import 文に惑わされない", async () => {
  const tmp1 = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-str-import-1-"));
  const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-str-import-2-"));
  try {
    await fs.writeFile(
      path.join(tmp1, "a.ts"),
      "export class Base { fromA: string = ''; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp1, "b.ts"),
      "export class Base { fromB: string = ''; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp1, "c.ts"),
      'import { Base } from "./b";\nconst msg = \'import { Base } from "./a"\';\nconst tpl = `import { Base } from "./a"`;\nexport class Child extends Base {}\n',
      "utf8"
    );
    const spec1 = await scanDirectory(tmp1, {});
    const child1 = spec1.classes.find((c) => c.name === "Child");
    assert.ok(child1);
    const rel1 = spec1.relations.find((r) => r.from === child1.id && r.type === "inheritance");
    assert.ok(rel1);
    const parent1 = spec1.classes.find((c) => c.id === rel1.to);
    assert.equal(parent1.name, "Base (b.ts)", `文字列内の疑似 import "./a" で ${parent1.name} に上書きされました`);

    await fs.writeFile(
      path.join(tmp2, "a.ts"),
      "export class Base { fromA: string = ''; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp2, "c.ts"),
      'const msg = \'import { Base } from "./a"\';\nexport class Base {}\nexport class Child extends Base {}\n',
      "utf8"
    );
    const spec2 = await scanDirectory(tmp2, {});
    const child2 = spec2.classes.find((c) => c.name === "Child");
    assert.ok(child2);
    const rel2 = spec2.relations.find((r) => r.from === child2.id && r.type === "inheritance");
    assert.ok(rel2);
    const parent2 = spec2.classes.find((c) => c.id === rel2.to);
    assert.equal(parent2.name, "Base (c.ts)", `ローカル Base ではなく ${parent2.name} が選ばれました`);
  } finally {
    await fs.rm(tmp1, { recursive: true, force: true });
    await fs.rm(tmp2, { recursive: true, force: true });
  }
});

test("Medium / Low: export { Base as default } を認識し、export { Local as default } from './a' を自モジュールの default export と誤認しない", async () => {
  const tmp1 = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-export-as-def-1-"));
  const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-export-as-def-2-"));
  try {
    await fs.writeFile(
      path.join(tmp1, "a.ts"),
      "export class Other {}\nexport class Base { fromA: string = ''; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp1, "b.ts"),
      "export class Helper {}\nexport class Base { fromB: string = ''; }\nexport { Base as default };\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp1, "c.ts"),
      'import Parent from "./b";\nexport class Child extends Parent {}\n',
      "utf8"
    );
    const spec1 = await scanDirectory(tmp1, {});
    const child1 = spec1.classes.find((c) => c.name === "Child");
    assert.ok(child1);
    const rel1 = spec1.relations.find((r) => r.from === child1.id && r.type === "inheritance");
    assert.ok(rel1, `export { Base as default } の inheritance が欠落しています: ${JSON.stringify(spec1.relations)}`);
    const parent1 = spec1.classes.find((c) => c.id === rel1.to);
    assert.equal(parent1.name, "Base (b.ts)", `export { Base as default } ではなく ${parent1.name} が選ばれました`);

    // b.ts 自身にも Local クラスがある状態で `export { Local as default } from "./a"` がある場合、
    // b.ts 側の Local (b.ts) ではなく、再エクスポート先 a.ts の Local へ正しく辿り着く。
    await fs.writeFile(
      path.join(tmp2, "a.ts"),
      "export class Local { fromA: string = ''; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp2, "b.ts"),
      'export class Local { fromB: string = \'\'; }\nexport class Helper {}\nexport { Local as default } from "./a";\n',
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp2, "c.ts"),
      'import Parent from "./b";\nexport class Child extends Parent {}\n',
      "utf8"
    );
    const spec2 = await scanDirectory(tmp2, {});
    const child2 = spec2.classes.find((c) => c.name === "Child");
    assert.ok(child2);
    const rel2 = spec2.relations.find((r) => r.from === child2.id && r.type === "inheritance");
    assert.ok(rel2, `export { Local as default } from "./a" の継承関係が解決されません: ${JSON.stringify(spec2.relations)}`);
    const parent2 = spec2.classes.find((c) => c.id === rel2.to);
    assert.equal(
      parent2.name,
      "Local",
      `a.ts の Local ではなく b.ts 自身の ${parent2.name} に誤認されました`
    );
  } finally {
    await fs.rm(tmp1, { recursive: true, force: true });
    await fs.rm(tmp2, { recursive: true, force: true });
  }
});

test("Medium: .mjs / .cjs 拡張子付き import 指定子から .mts / .cts ソースを解決できる", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-mts-esm-"));
  try {
    await fs.writeFile(
      path.join(tmp, "a.mts"),
      "export default class Base { fromA: string = ''; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "b.mts"),
      "export class Helper {}\nexport default class Base { fromB: string = ''; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "c.mts"),
      'import Parent from "./b.mjs";\nexport class Child extends Parent {}\n',
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "d.cts"),
      "export default class CjsBase { fromD: string = ''; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "e.cts"),
      'import CjsParent from "./d.cjs";\nexport class CjsChild extends CjsParent {}\n',
      "utf8"
    );
    const spec = await scanDirectory(tmp, {});
    const child = spec.classes.find((c) => c.name === "Child");
    assert.ok(child);
    const rel = spec.relations.find((r) => r.from === child.id && r.type === "inheritance");
    assert.ok(rel, `./b.mjs -> b.mts の inheritance が欠落しています: ${JSON.stringify(spec.relations)}`);
    const parent = spec.classes.find((c) => c.id === rel.to);
    assert.equal(parent.name, "Base (b.mts)", `b.mts の default export ではなく ${parent.name} が選ばれました`);

    const cjsChild = spec.classes.find((c) => c.name === "CjsChild");
    assert.ok(cjsChild);
    const cjsRel = spec.relations.find((r) => r.from === cjsChild.id && r.type === "inheritance");
    assert.ok(cjsRel, `./d.cjs -> d.cts の inheritance が欠落しています: ${JSON.stringify(spec.relations)}`);
    const cjsParent = spec.classes.find((c) => c.id === cjsRel.to);
    assert.equal(cjsParent.name, "CjsBase");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: base.mts と base.cts が同居（同名 Base も含む）しても ./base.mjs は base.mts、./base.cjs は base.cts を選ぶ", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-mts-vs-cts-"));
  try {
    // base.cts が走査順で先に来るうえ両者に同名クラス Base があっても、拡張子系統で正しく切り分ける
    await fs.writeFile(
      path.join(tmp, "base.cts"),
      "export default class Base { fromCts: string = ''; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "base.mts"),
      "export default class Base { fromMts: string = ''; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "use-esm.mts"),
      'import Parent from "./base.mjs";\nexport class EsmChild extends Parent {}\n',
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "use-cjs.cts"),
      'import Parent from "./base.cjs";\nexport class CjsChild extends Parent {}\n',
      "utf8"
    );
    const spec = await scanDirectory(tmp, {});
    const esmChild = spec.classes.find((c) => c.name === "EsmChild");
    const cjsChild = spec.classes.find((c) => c.name === "CjsChild");
    assert.ok(esmChild && cjsChild);
    const esmRel = spec.relations.find((r) => r.from === esmChild.id && r.type === "inheritance");
    const cjsRel = spec.relations.find((r) => r.from === cjsChild.id && r.type === "inheritance");
    assert.ok(esmRel && cjsRel, `継承関係が不足しています: ${JSON.stringify(spec.relations)}`);
    assert.equal(spec.classes.find((c) => c.id === esmRel.to).name, "Base (base.mts)");
    assert.equal(spec.classes.find((c) => c.id === cjsRel.to).name, "Base");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("High: NOTICE/・README.md/../NOTICE・missing/../NOTICE など非ディレクトリ経由の出力指定はすべて拒否し元ファイルを壊さない", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-nondir-"));
  try {
    const noticePath = path.join(tmp, "NOTICE");
    const readmePath = path.join(tmp, "README.md");
    const noticeBody = "ORIGINAL NOTICE SENTINEL\n";
    await fs.writeFile(noticePath, noticeBody, "utf8");
    await fs.writeFile(readmePath, "# README\n", "utf8");
    await fs.writeFile(path.join(tmp, "diagram.drawio"), MINIMAL_DRAWIO, "utf8");
    await fs.writeFile(path.join(tmp, "sample.ts"), "export class Alpha {}\n", "utf8");
    await fs.writeFile(path.join(tmp, "schema.sql"), "CREATE TABLE t (id INT PRIMARY KEY);\n", "utf8");

    const invalidTargets = [
      path.join(tmp, "NOTICE") + path.sep,
      rawJoin(tmp, "README.md", "..", "NOTICE"),
      rawJoin(tmp, "NOTICE", "."),
      rawJoin(tmp, "missing", "..", "NOTICE"),
    ];
    for (const bad of invalidTargets) {
      assert.throws(() => resolveWriteTarget(bad), { code: /ENOTDIR|ENOENT|EISDIR/ }, `resolveWriteTarget が ${bad} を許しました`);
      await assert.rejects(() => writeFileAtomic(bad, "CORRUPTED\n"), { code: /ENOTDIR|ENOENT|EISDIR/ });
    }

    for (const relBad of [
      `NOTICE${path.sep}`,
      rawJoin("README.md", "..", "NOTICE"),
      rawJoin("missing", "..", "NOTICE"),
    ]) {
      const pngRun = runScript("drawio2png.mjs", ["diagram.drawio", "-o", relBad], tmp);
      assert.equal(pngRun.status, 1, `drawio2png -o ${relBad} が exit(1) になりません`);

      const clsRun = runScript("scan-classes.mjs", ["--src-dir", tmp, "-o", relBad], tmp);
      assert.equal(clsRun.status, 1, `scan-classes -o ${relBad} が exit(1) になりません`);
    }

    // --json-out は正当でも後続の --xml-out が README.md/../NOTICE なら、--json-out も 1 バイトも書かずに exit(1)
    const okJson = path.join(tmp, "ok.json");
    const erRun = runScript(
      "build-er.mjs",
      ["--schema", "schema.sql", "--json-out", okJson, "--xml-out", rawJoin("README.md", "..", "NOTICE"), "-o", "out.png"],
      tmp
    );
    assert.equal(erRun.status, 1, `build-er が不正な --xml-out を通しました:\n${erRun.stderr}`);
    assert.ok(!fsSync.existsSync(okJson), "不正な --xml-out があるのに先の --json-out を書いてしまいました");
    assert.equal(await fs.readFile(noticePath, "utf8"), noticeBody, "NOTICE が改変されています");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: splitPathRoot が Windows の C:/work/out.png・C:\\work・UNC・POSIX バックスラッシュを正しく切り分ける", () => {
  assert.deepEqual(splitPathRoot("C:/work/out.png", "win32", "D:\\proj"), {
    isAbs: true,
    root: "C:\\",
    baseDir: "D:\\proj",
    rest: "work/out.png",
  });
  assert.deepEqual(splitPathRoot("c:\\work\\out.png", "win32", "D:\\proj"), {
    isAbs: true,
    root: "C:\\",
    baseDir: "D:\\proj",
    rest: "work\\out.png",
  });
  assert.deepEqual(splitPathRoot("//filesrv/share/a/b.png", "win32", "C:\\proj"), {
    isAbs: true,
    root: "\\\\filesrv\\share\\",
    baseDir: "C:\\proj",
    rest: "a/b.png",
  });
  assert.deepEqual(splitPathRoot("/work/out.png", "win32", "D:\\proj"), {
    isAbs: true,
    root: "D:\\",
    baseDir: "D:\\proj",
    rest: "work/out.png",
  });
  assert.deepEqual(splitPathRoot("sub\\file.png", "linux", "/app"), {
    isAbs: false,
    root: "/",
    baseDir: "/app",
    rest: "sub\\file.png",
  });
});

test("Medium: SNS HTTPS 購読の endpoint=var.* + redrive_policy や EventBridge DLQ で無関係な SQS へ誤結線しない", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-tf-redrive-"));
  const TF = `
resource "aws_sns_topic" "events" {
  name = "events"
}

resource "aws_sqs_queue" "dlq" {
  name = "events-dlq"
}

resource "aws_sns_topic_subscription" "webhook" {
  topic_arn = aws_sns_topic.events.arn
  protocol  = "https"
  endpoint  = var.callback_url
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
  })
}

resource "aws_cloudwatch_event_rule" "sched" {
  name                = "sched"
  schedule_expression = "rate(1 hour)"
}

resource "aws_cloudwatch_event_target" "ext" {
  rule = aws_cloudwatch_event_rule.sched.name
  arn  = var.external_target_arn
  dead_letter_config {
    arn = aws_sqs_queue.dlq.arn
  }
}
`;
  try {
    await fs.writeFile(path.join(tmp, "main.tf"), TF, "utf8");
    const spec = await scanTerraformDirectory(tmp, {});
    assert.equal(
      spec.edges.length,
      0,
      `redrive_policy / dead_letter_config の DLQ へ誤った辺が張られています: ${JSON.stringify(spec.edges)}`
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium / Low: drawio2png --all-pages はページ出力同士の symlink 衝突を書き込み前に拒否する", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-allpages-"));
  try {
    const multiXml =
      '<mxfile>' +
      '<diagram id="p1" name="PageA"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="A" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="20" y="20" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram>' +
      '<diagram id="p2" name="PageB"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="b" value="B" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="20" y="20" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram>' +
      '</mxfile>';
    const inXml = path.join(tmp, "multi.drawio");
    const page1Out = path.join(tmp, "out-1-PageA.png");
    const page2Out = path.join(tmp, "out-2-PageB.png");
    const sentinel = Buffer.from("SENTINEL-PAGE-BYTES");
    await fs.writeFile(inXml, multiXml, "utf8");
    await fs.writeFile(page1Out, sentinel);
    const linked = await trySymlink("out-1-PageA.png", page2Out);
    if (!linked) {
      t.skip("symlink を作成できない環境のためスキップ");
      return;
    }

    const res = runScript("drawio2png.mjs", ["multi.drawio", "--all-pages", "-o", "out.png"], tmp);
    assert.equal(res.status, 1, `--all-pages 出力衝突が exit(1) になりません:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /衝突/, `衝突理由が出力されていません: ${res.stderr}`);
    assert.ok((await fs.readFile(page1Out)).equals(sentinel), "ページ 1 の既存ファイルが上書きされました");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: drawio2png --all-pages はページ 1 未作成時の dangling symlink (ページ2 -> ページ1) も事前検知する", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-allpages-dangling-"));
  try {
    const multiXml =
      '<mxfile>' +
      '<diagram id="p1" name="PageA"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="A" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="20" y="20" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram>' +
      '<diagram id="p2" name="PageB"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="b" value="B" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="20" y="20" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram>' +
      '</mxfile>';
    await fs.writeFile(path.join(tmp, "multi.drawio"), multiXml, "utf8");
    const page1Out = path.join(tmp, "out-1-PageA.png");
    const page2Out = path.join(tmp, "out-2-PageB.png");
    // ページ 1 のファイルはまだ存在しない状態で、ページ 2 だけを page 1 への dangling symlink にしておく
    const linked = await trySymlink("out-1-PageA.png", page2Out);
    if (!linked) {
      t.skip("symlink を作成できない環境のためスキップ");
      return;
    }

    const res = runScript("drawio2png.mjs", ["multi.drawio", "--all-pages", "-o", "out.png"], tmp);
    assert.equal(res.status, 1, `dangling symlink 衝突が exit(1) になりません:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /衝突/, `衝突理由が出力されていません: ${res.stderr}`);
    assert.ok(!fsSync.existsSync(page1Out), "事前検知で止まらずページ 1 を作ってしまいました");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: emitDiagramFiles は画像側の一時ファイル作成失敗時に既存 XML を無傷のまま保ち一時ファイルを残さない", async (t) => {
  if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
    t.skip("Windows または root 環境ではディレクトリ 0555 による書き込み拒否が成立しないためスキップ");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-pair-atomic-"));
  const xmlDir = path.join(tmp, "xml");
  const pngDir = path.join(tmp, "png");
  try {
    await fs.mkdir(xmlDir, { recursive: true });
    await fs.mkdir(pngDir, { recursive: true });
    const xmlPath = path.join(xmlDir, "out.drawio");
    const pngPath = path.join(pngDir, "out.png");
    const sentinelXml = "<mxfile>SENTINEL</mxfile>";
    await fs.writeFile(xmlPath, sentinelXml, "utf8");
    await fs.chmod(pngDir, 0o555);

    let errCaught = null;
    await assert.rejects(
      () =>
        emitDiagramFiles({
          xml: "<mxfile>NEW</mxfile>",
          outPath: pngPath,
          xmlOutPath: xmlPath,
          convertPng: () => ({ png: Buffer.from("PNG"), width: 10, height: 10 }),
          convertSvg: () => ({ svg: "<svg/>", width: 10, height: 10 }),
        }),
      (err) => {
        errCaught = err;
        return Boolean(err);
      }
    );
    // 排他ロック（/tmp 配下）を通過し、実際に pngDir への stageTempFile で失敗したことを確認する
    assert.ok(
      String(errCaught?.path || "").includes(".drawio.tmp-"),
      `stageTempFile ではなくロック等で先に失敗しました: ${errCaught?.code} ${errCaught?.path} ${errCaught?.message}`
    );

    assert.equal(await fs.readFile(xmlPath, "utf8"), sentinelXml, "画像書込失敗時に XML だけが更新されました");
    assert.deepEqual(await fs.readdir(xmlDir), ["out.drawio"], "XML 側に一時ファイルが残っています");
    assert.deepEqual(await fs.readdir(pngDir), [], "画像側に一時ファイルが残っています");
  } finally {
    await fs.chmod(pngDir, 0o755).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: emitDiagramFiles の同一出力先への並行実行でも XML と画像の世代が混在しない", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-pair-concurrent-"));
  try {
    const xmlPath = path.join(tmp, "out.drawio");
    const pngPath = path.join(tmp, "out.png");
    const big = "X".repeat(128 * 1024);
    for (let round = 0; round < 10; round += 1) {
      await Promise.all([
        emitDiagramFiles({
          xml: `<mxfile gen="A-${round}">${big}</mxfile>`,
          outPath: pngPath,
          xmlOutPath: xmlPath,
          convertPng: () => ({ png: Buffer.from(`PNG:A-${round}:${big}`), width: 10, height: 10 }),
          convertSvg: () => ({ svg: "<svg/>", width: 10, height: 10 }),
        }),
        emitDiagramFiles({
          xml: `<mxfile gen="B-${round}"/>`,
          outPath: pngPath,
          xmlOutPath: xmlPath,
          convertPng: () => ({ png: Buffer.from(`PNG:B-${round}`), width: 10, height: 10 }),
          convertSvg: () => ({ svg: "<svg/>", width: 10, height: 10 }),
        }),
      ]);
      const finalXml = await fs.readFile(xmlPath, "utf8");
      const finalPng = await fs.readFile(pngPath, "utf8");
      const xmlGen = finalXml.match(/gen="([AB]-\d+)"/)?.[1];
      const pngGen = finalPng.match(/^PNG:([AB]-\d+)/)?.[1];
      assert.ok(xmlGen && pngGen, `世代ラベルが欠落: ${finalXml.slice(0, 40)} / ${finalPng.slice(0, 40)}`);
      assert.equal(xmlGen, pngGen, `round ${round}: XML (${xmlGen}) と画像 (${pngGen}) の世代が混在しました`);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: POSIX で既存 0600 ファイルを writeFileAtomic / emitDiagramFiles で更新しても 0600 のまま維持する", async () => {
  if (process.platform === "win32") return;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-mode-"));
  try {
    const secretJson = path.join(tmp, "secret.json");
    const secretXml = path.join(tmp, "secret.drawio");
    const secretPng = path.join(tmp, "secret.png");
    await fs.writeFile(secretJson, "{}\n", { mode: 0o600 });
    await fs.chmod(secretJson, 0o600);
    await fs.writeFile(secretXml, "<old/>", { mode: 0o600 });
    await fs.chmod(secretXml, 0o600);
    await fs.writeFile(secretPng, Buffer.from("OLD"), { mode: 0o600 });
    await fs.chmod(secretPng, 0o600);

    await writeFileAtomic(secretJson, '{"updated":true}\n');
    await emitDiagramFiles({
      xml: "<new/>",
      outPath: secretPng,
      xmlOutPath: secretXml,
      convertPng: () => ({ png: Buffer.from("NEWPNG"), width: 10, height: 10 }),
      convertSvg: () => ({ svg: "<svg/>", width: 10, height: 10 }),
    });

    assert.equal((await fs.stat(secretJson)).mode & 0o777, 0o600, "writeFileAtomic で 0600 権限が広がりました");
    assert.equal((await fs.stat(secretXml)).mode & 0o777, 0o600, "emitDiagramFiles (XML) で 0600 権限が広がりました");
    assert.equal((await fs.stat(secretPng)).mode & 0o777, 0o600, "emitDiagramFiles (PNG) で 0600 権限が広がりました");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: base.mts とコンパイル済み base.mjs が同居しても ./base.mjs は TypeScript 側 base.mts を優先する", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-ext-prio-"));
  try {
    // base.mjs は辞書順で base.mts より先に来るが、TS ソースの base.mts が優先されなければならない
    await fs.writeFile(
      path.join(tmp, "base.mjs"),
      "export default class CompiledJsBase { compiled: boolean = true; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "base.mts"),
      "export default class TsSourceBase { tsSource: boolean = true; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "child.mts"),
      'import Base from "./base.mjs";\nexport class MtsChild extends Base {}\n',
      "utf8"
    );
    // 通常の base.ts + コンパイル済み base.js でも `./base.js` は base.ts を優先する
    await fs.writeFile(
      path.join(tmp, "norm.js"),
      "export class CompiledNormalBase {}\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "norm.ts"),
      "export class TsNormalBase {}\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "norm-child.ts"),
      'import { TsNormalBase } from "./norm.js";\nexport class NormChild extends TsNormalBase {}\n',
      "utf8"
    );

    const spec = await scanDirectory(tmp, {});
    const mtsChild = spec.classes.find((c) => c.name === "MtsChild");
    const rel = spec.relations.find((r) => r.from === mtsChild.id && r.type === "inheritance");
    assert.ok(rel, `inheritance がありません: ${JSON.stringify(spec.relations)}`);
    assert.equal(spec.classes.find((c) => c.id === rel.to).name, "TsSourceBase");

    const normChild = spec.classes.find((c) => c.name === "NormChild");
    const normRel = spec.relations.find((r) => r.from === normChild.id && r.type === "inheritance");
    assert.ok(normRel);
    assert.equal(spec.classes.find((c) => c.id === normRel.to).name, "TsNormalBase");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: default 再エクスポート解決失敗時に中継モジュールの単一ローカル型へ誤結線せず、有効な再エクスポート先は辿る", async () => {
  const tmp1 = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-barrel-1-"));
  const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-barrel-2-"));
  try {
    // ケース 1: b.ts に UnrelatedLocal が 1 つだけあり、default re-export 先が未解決（./missing）
    await fs.writeFile(
      path.join(tmp1, "b.ts"),
      'class UnrelatedLocal {}\nexport { Missing as default } from "./missing";\n',
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp1, "c.ts"),
      'import Parent from "./b";\nexport class Child extends Parent {}\n',
      "utf8"
    );
    const spec1 = await scanDirectory(tmp1, {});
    assert.equal(
      spec1.relations.filter((r) => r.from === "Child").length,
      0,
      `未解決の default re-export なのに中継側の単一ローカル型へ誤結線しました: ${JSON.stringify(spec1.relations)}`
    );

    // ケース 2: a.ts の RealBase を b.ts が `export { RealBase as default } from "./a"` で再公開し、b.ts には UnrelatedLocal がある
    await fs.writeFile(
      path.join(tmp2, "a.ts"),
      "export class RealBase { ok: boolean = true; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp2, "b.ts"),
      'class UnrelatedLocal {}\nexport { RealBase as default } from "./a";\n',
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp2, "c.ts"),
      'import Parent from "./b";\nexport class Child extends Parent {}\n',
      "utf8"
    );
    const spec2 = await scanDirectory(tmp2, {});
    const rel2 = spec2.relations.find((r) => r.from === "Child" && r.type === "inheritance");
    assert.ok(rel2, `default re-export チェーンが解決されません: ${JSON.stringify(spec2.relations)}`);
    assert.equal(spec2.classes.find((c) => c.id === rel2.to).name, "RealBase");
  } finally {
    await fs.rm(tmp1, { recursive: true, force: true });
    await fs.rm(tmp2, { recursive: true, force: true });
  }
});

test("Medium: scan-classes / build-class は絶対パスの --src-dir を title / subtitle / JSON に生出ししない", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-class-safedir-"));
  const srcDir = path.join(tmp, "my-domain");
  const outXml = path.join(tmp, "out.drawio");
  const outPng = path.join(tmp, "out.drawio.png");
  try {
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, "Order.ts"), "export class Order { id: string = ''; }\n", "utf8");

    const spec = await scanDirectory(srcDir, {});
    assert.ok(!spec.subtitle.includes(srcDir), `subtitle に絶対パスが含まれています: ${spec.subtitle}`);
    assert.ok(!spec.subtitle.includes(os.tmpdir()), `subtitle に tmpdir 絶対パスが含まれています: ${spec.subtitle}`);
    assert.ok(spec.subtitle.includes("my-domain"), `subtitle に末尾ディレクトリ名がありません: ${spec.subtitle}`);

    const r = runScript("build-class.mjs", ["--src-dir", srcDir, "--no-png", "--xml-out", outXml, "-o", outPng], tmp);
    assert.equal(r.status, 0, `build-class 失敗:\n${r.stdout}\n${r.stderr}`);
    const xml = await fs.readFile(outXml, "utf8");
    assert.ok(!xml.includes(srcDir), `生成 XML のタイトル等に絶対パスが含まれています`);
    assert.ok(xml.includes("Class diagram (my-domain)"), "生成 XML に安全な短縮タイトルがありません");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: 別々の CLI プロセスが同じ出力先へ emitDiagramFiles を並行実行しても XML と画像の世代が混在せず lockfile も残らない", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-xproc-lock-"));
  try {
    const sharedUrl = pathToFileURL(path.join(ROOT, "scripts", "diagram-shared.mjs")).href;
    const xmlPath = path.join(tmp, "out.drawio");
    const pngPath = path.join(tmp, "out.png");
    const workerCode = `
      import { emitDiagramFiles } from ${JSON.stringify(sharedUrl)};
      const gen = process.env.WORKER_GEN;
      const rounds = Number(process.env.WORKER_ROUNDS || "5");
      const pad = "Z".repeat(gen === "A" ? 256 * 1024 : 32);
      for (let i = 0; i < rounds; i += 1) {
        const tag = gen + "-" + i;
        await emitDiagramFiles({
          xml: '<mxfile gen="' + tag + '">' + pad + '</mxfile>',
          outPath: process.env.OUT_PNG,
          xmlOutPath: process.env.OUT_XML,
          convertPng: () => ({ png: Buffer.from("PNG:" + tag + ":" + pad), width: 10, height: 10 }),
          convertSvg: () => ({ svg: "<svg/>", width: 10, height: 10 }),
        });
      }
    `;
    const runWorker = (gen) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", workerCode],
          {
            cwd: tmp,
            env: { ...process.env, WORKER_GEN: gen, WORKER_ROUNDS: "6", OUT_XML: xmlPath, OUT_PNG: pngPath },
            stdio: ["ignore", "pipe", "pipe"],
          }
        );
        let stderr = "";
        child.stderr.on("data", (d) => {
          stderr += d.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`worker ${gen} exited ${code}: ${stderr}`));
        });
      });

    await Promise.all([runWorker("A"), runWorker("B")]);

    const finalXml = await fs.readFile(xmlPath, "utf8");
    const finalPng = await fs.readFile(pngPath, "utf8");
    const xmlGen = finalXml.match(/gen="([AB]-\d+)"/)?.[1];
    const pngGen = finalPng.match(/^PNG:([AB]-\d+):/)?.[1];
    assert.ok(xmlGen && pngGen, "最終出力に世代タグがありません");
    assert.equal(xmlGen, pngGen, `プロセス間並行実行で XML (${xmlGen}) と PNG (${pngGen}) の世代が混在しました`);
    assert.deepEqual(
      (await fs.readdir(tmp)).sort(),
      ["out.drawio", "out.png"],
      "完了後に lockfile や一時ファイルが残っています"
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: export { default } from './a' で default 未定義の単一名前付きクラスへ誤結線しない", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-reexp-nodef-"));
  try {
    await fs.writeFile(
      path.join(tmp, "a.ts"),
      "export class OnlyNamed { x: number = 1; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "b.ts"),
      'export { default } from "./a";\n',
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "c.ts"),
      'import Parent from "./b";\nexport class Child extends Parent {}\n',
      "utf8"
    );
    const spec = await scanDirectory(tmp, {});
    assert.equal(
      spec.relations.filter((r) => r.from === "Child").length,
      0,
      `default 未定義のモジュールから誤った継承線が生成されました: ${JSON.stringify(spec.relations)}`
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: export { Actual as Base } と export { Base as default } from './a' の別名再エクスポートを追跡できる", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-alias-reexp-"));
  try {
    await fs.writeFile(
      path.join(tmp, "a.ts"),
      "class Actual { ok: boolean = true; }\nexport { Actual as Base };\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "b.ts"),
      'export { Base as default } from "./a";\n',
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "c.ts"),
      'import Parent from "./b";\nexport class Child extends Parent {}\n',
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "d.ts"),
      'import { Base } from "./a";\nexport class DirectChild extends Base {}\n',
      "utf8"
    );
    const spec = await scanDirectory(tmp, {});
    const relC = spec.relations.find((r) => r.from === "Child" && r.type === "inheritance");
    const relD = spec.relations.find((r) => r.from === "DirectChild" && r.type === "inheritance");
    assert.ok(relC, `export { Actual as Base } -> export { Base as default } が欠落しています: ${JSON.stringify(spec.relations)}`);
    assert.ok(relD, `import { Base } from ./a (export { Actual as Base }) が欠落しています: ${JSON.stringify(spec.relations)}`);
    assert.equal(spec.classes.find((c) => c.id === relC.to).name, "Actual");
    assert.equal(spec.classes.find((c) => c.id === relD.to).name, "Actual");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: FIFO やデバイスなど特殊ファイルを出力先に指定したら上書きも読み取り待ちもせず拒否する", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows では POSIX FIFO がないためスキップ");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-fifo-"));
  let child = null;
  try {
    const fifoPath = path.join(tmp, "out.fifo");
    const mk = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
    if (mk.status !== 0) {
      t.skip("mkfifo を作成できない環境のためスキップ");
      return;
    }

    assert.throws(() => resolveWriteTarget(fifoPath), { code: "EINVAL" });

    const outPng = path.join(tmp, "out.png");
    const sharedUrl = pathToFileURL(path.join(ROOT, "scripts/diagram-shared.mjs")).href;
    const fifoScript = `
      const { writeFileAtomic, emitDiagramFiles } = await import(process.argv[1]);
      let code1 = "";
      try {
        await writeFileAtomic(process.argv[2], "OVERWRITE");
        code1 = "UNEXPECTED_OK";
      } catch (err) {
        code1 = err && err.code ? err.code : String(err);
      }
      let code2 = "";
      try {
        await emitDiagramFiles({
          xml: process.argv[4],
          outPath: process.argv[3],
          xmlOutPath: process.argv[2],
          convertPng: () => ({ png: Buffer.from("PNG"), width: 10, height: 10 }),
          convertSvg: () => ({ svg: "<svg/>", width: 10, height: 10 }),
        });
        code2 = "UNEXPECTED_OK";
      } catch (err) {
        code2 = err && err.code ? err.code : String(err);
      }
      process.stdout.write(JSON.stringify({ code1, code2 }) + "\\n");
    `;

    let timedOut = false;
    child = spawn(
      process.execPath,
      ["--input-type=module", "-e", fifoScript, sharedUrl, fifoPath, outPng, MINIMAL_DRAWIO],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      errOut += d.toString();
    });

    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 3000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    assert.equal(timedOut, false, `XML/atomic FIFO テストがタイムアウト強制終了しました (${out} / ${errOut})`);
    assert.equal(exitCode, 0, `子プロセスが異常終了しました: code=${exitCode} err=${errOut}`);
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.code1, "EINVAL", "writeFileAtomic(fifo) が EINVAL ではありません");
    assert.equal(parsed.code2, "EINVAL", "emitDiagramFiles(xmlOut=fifo) が EINVAL ではありません");
    assert.ok(fsSync.lstatSync(fifoPath).isFIFO(), "writeFileAtomic / emitDiagramFiles で FIFO が置換されました");
    assert.ok(!fsSync.existsSync(outPng), "FIFO エラー前に PNG が書かれました");

    const inXml = path.join(tmp, "in.drawio");
    await fs.writeFile(inXml, MINIMAL_DRAWIO, "utf8");
    const r = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts/drawio2png.mjs"), "in.drawio", "-o", "out.fifo"],
      { cwd: tmp, encoding: "utf8", timeout: 5000 }
    );
    assert.equal(r.signal, null, `drawio2png -o out.fifo がタイムアウト/シグナル終了しました: ${r.signal}`);
    assert.equal(r.status, 1, `drawio2png -o out.fifo が exit(1) になりません:\n${r.stderr}`);
    assert.ok(fsSync.lstatSync(fifoPath).isFIFO(), "drawio2png で FIFO が通常ファイルに置換されました");
  } finally {
    if (child) child.kill("SIGKILL");
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: 未作成の --json-out result と --xml-out result/out.drawio のような出力先親子衝突を 1 バイトも書かずに拒否する", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-ancestor-out-"));
  try {
    assert.throws(
      () =>
        assertDistinctPaths([
          { role: "--xml-out", value: path.join(tmp, "res") },
          { role: "--output", value: path.join(tmp, "res", "out.png") },
        ]),
      /親子パスで衝突/
    );

    const sql = path.join(tmp, "schema.sql");
    await fs.writeFile(sql, "CREATE TABLE t (id INTEGER PRIMARY KEY);\n", "utf8");

    for (const args of [
      ["--schema", sql, "--json-out", "result", "--xml-out", rawJoin("result", "out.drawio"), "-o", rawJoin("result", "out.png")],
      ["--schema", sql, "--xml-out", rawJoin("result", "out.drawio"), "-o", rawJoin("result", "out.png"), "--json-out", "result"],
    ]) {
      const r = runScript("build-er.mjs", args, tmp);
      assert.equal(r.status, 1, `親子出力衝突 (${args.join(" ")}) が exit(1) になりません:\n${r.stderr}`);
      assert.match(r.stderr, /親子パスで衝突/, `衝突理由が出力されていません: ${r.stderr}`);
      assert.ok(!fsSync.existsSync(path.join(tmp, "result")), "衝突時に result が一部作成されました");
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("High: 出力ディレクトリの既存 .drawio-lock ファイルや --xml-out .out.png.drawio-lock をロック機構で削除・破壊しない", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-lock-clash-"));
  try {
    const decoyLock = path.join(tmp, ".out.png.drawio-lock");
    const decoyBody = "USER IMPORTANT FILE DO NOT DELETE\n";
    await fs.writeFile(decoyLock, decoyBody, "utf8");
    const oldTime = new Date(Date.now() - 180 * 1000);
    await fs.utimes(decoyLock, oldTime, oldTime);

    const outXml = path.join(tmp, "out.drawio");
    const outPng = path.join(tmp, "out.png");
    await emitDiagramFiles({
      xml: "<mxfile>OK</mxfile>",
      outPath: outPng,
      xmlOutPath: outXml,
      convertPng: () => ({ png: Buffer.from("PNG"), width: 10, height: 10 }),
      convertSvg: () => ({ svg: "<svg/>", width: 10, height: 10 }),
    });
    assert.equal(await fs.readFile(decoyLock, "utf8"), decoyBody, "既存の .out.png.drawio-lock が破壊／削除されました");

    // --xml-out に直接 .out.png.drawio-lock を指定しても、完了後に消されない
    await emitDiagramFiles({
      xml: "<mxfile>AS-XML-OUT</mxfile>",
      outPath: outPng,
      xmlOutPath: decoyLock,
      convertPng: () => ({ png: Buffer.from("PNG2"), width: 10, height: 10 }),
      convertSvg: () => ({ svg: "<svg/>", width: 10, height: 10 }),
    });
    assert.equal(await fs.readFile(decoyLock, "utf8"), "<mxfile>AS-XML-OUT</mxfile>");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: 死亡 PID の古いロックは回収でき、生存 PID の古いロックは 60 秒経過しても奪取しない", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-lock-liveness-"));
  try {
    const targetPng = path.join(tmp, "out.png");
    const { lockPath } = await getTargetLockPaths(targetPng);

    // 1) 確実に終了済みの子プロセス PID で古いロックを置き、安全に回収して書き込めることを確かめる
    const deadChild = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((res) => deadChild.on("close", res));
    await fs.writeFile(
      lockPath,
      JSON.stringify({ magic: "drawio-diagrams-lock-v1", pid: deadChild.pid, nonce: "dead", createdAt: Date.now() - 120000 }),
      { mode: 0o600 }
    );
    const oldTime = new Date(Date.now() - 120000);
    await fs.utimes(lockPath, oldTime, oldTime);

    await emitDiagramFiles({
      xml: "<mxfile/>",
      outPath: targetPng,
      convertPng: () => ({ png: Buffer.from("RECLAIMED"), width: 10, height: 10 }),
      convertSvg: () => ({ svg: "<svg/>", width: 10, height: 10 }),
    });
    assert.equal(await fs.readFile(targetPng, "utf8"), "RECLAIMED");
    assert.ok(!fsSync.existsSync(lockPath), "回収後のロックが解放されていません");

    // 2) 生存中の別プロセスが 120 秒前の mtime でロックを持っているとき、奪取しない
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000);"], { stdio: "ignore" });
    try {
      await fs.writeFile(
        lockPath,
        JSON.stringify({ magic: "drawio-diagrams-lock-v1", pid: sleeper.pid, nonce: "alive", createdAt: Date.now() - 120000 }),
        { mode: 0o600 }
      );
      await fs.utimes(lockPath, oldTime, oldTime);
      // 同一プロセス内の他出力とは無関係なのでタイムアウトテストは行わず、生存ロックのまま別ファイルには影響しないことと、
      // 実際に同一パスなら解放（sleeper 終了）後にすぐ取れることを確認する
      let done = false;
      const pending = emitDiagramFiles({
        xml: "<mxfile/>",
        outPath: targetPng,
        convertPng: () => ({ png: Buffer.from("AFTER-SLEEPER"), width: 10, height: 10 }),
        convertSvg: () => ({ svg: "<svg/>", width: 10, height: 10 }),
      }).then(() => {
        done = true;
      });
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(done, false, "生存中の PID が持つ 120 秒前のロックを奪取してしまいました");
      sleeper.kill("SIGKILL");
      await new Promise((res) => sleeper.on("close", res));
      await pending;
      assert.equal(await fs.readFile(targetPng, "utf8"), "AFTER-SLEEPER");
    } finally {
      sleeper.kill("SIGKILL");
      await fs.rm(lockPath, { force: true }).catch(() => {});
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: export { Actual as Base } from './a' と非公開の class Base が共存しても非公開クラスへ誤結線しない", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-reexp-shadow-"));
  try {
    await fs.writeFile(
      path.join(tmp, "a.ts"),
      "export class Actual { fromA: boolean = true; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "b.ts"),
      'class Base { privateLocal: boolean = true; }\nexport { Actual as Base } from "./a";\n',
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "c.ts"),
      'import { Base } from "./b";\nexport class Child extends Base {}\n',
      "utf8"
    );
    const spec = await scanDirectory(tmp, {});
    const rel = spec.relations.find((r) => r.from === "Child" && r.type === "inheritance");
    assert.ok(rel, `inheritance がありません: ${JSON.stringify(spec.relations)}`);
    assert.equal(
      spec.classes.find((c) => c.id === rel.to).name,
      "Actual",
      "非公開 class Base へ誤結線しました"
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: import { Actual } from './a'; export { Actual as default } / export default Actual を解決する", async () => {
  const tmp1 = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-imp-def-1-"));
  const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-imp-def-2-"));
  try {
    await fs.writeFile(path.join(tmp1, "a.ts"), "export class Actual { v: number = 1; }\n", "utf8");
    await fs.writeFile(
      path.join(tmp1, "b.ts"),
      'import { Actual } from "./a";\nexport { Actual as default };\n',
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp1, "c.ts"),
      'import Parent from "./b";\nexport class Child extends Parent {}\n',
      "utf8"
    );
    const spec1 = await scanDirectory(tmp1, {});
    const rel1 = spec1.relations.find((r) => r.from === "Child" && r.type === "inheritance");
    assert.ok(rel1, `export { Actual as default } が解決できません: ${JSON.stringify(spec1.relations)}`);
    assert.equal(spec1.classes.find((c) => c.id === rel1.to).name, "Actual");

    await fs.writeFile(path.join(tmp2, "a.ts"), "export class Actual { v: number = 2; }\n", "utf8");
    await fs.writeFile(
      path.join(tmp2, "b.ts"),
      'import { Actual } from "./a";\nexport default Actual;\n',
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp2, "c.ts"),
      'import Parent from "./b";\nexport class Child extends Parent {}\n',
      "utf8"
    );
    const spec2 = await scanDirectory(tmp2, {});
    const rel2 = spec2.relations.find((r) => r.from === "Child" && r.type === "inheritance");
    assert.ok(rel2, `export default Actual が解決できません: ${JSON.stringify(spec2.relations)}`);
    assert.equal(spec2.classes.find((c) => c.id === rel2.to).name, "Actual");
  } finally {
    await fs.rm(tmp1, { recursive: true, force: true });
    await fs.rm(tmp2, { recursive: true, force: true });
  }
});


test("Medium: ensureLockDir は既存の 0777/0755 ディレクトリを EACCES で拒否し、作成不可時もフェイルクローズして新規作成時は 0700 を保証する", async (t) => {
  if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
    t.skip("POSIX 非 root のみ権限ビット検証を実施");
    return;
  }
  const tmpBad = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-lockdir-bad-"));
  const tmpFresh = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-lockdir-fresh-"));
  const tmpRo = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-lockdir-ro-"));
  try {
    const uidPart = `u${process.getuid()}`;
    const badDir = path.join(tmpBad, `drawio-diagrams-locks-${uidPart}`);
    await fs.mkdir(badDir, { mode: 0o777 });
    await fs.chmod(badDir, 0o777);
    await assert.rejects(
      () => ensureLockDir(tmpBad),
      (err) => err && err.code === "EACCES"
    );

    await fs.chmod(badDir, 0o755);
    await assert.rejects(
      () => ensureLockDir(tmpBad),
      (err) => err && err.code === "EACCES"
    );

    await fs.chmod(tmpRo, 0o555);
    await assert.rejects(
      () => ensureLockDir(tmpRo),
      (err) => err && err.code === "EACCES"
    );

    const freshDir = await ensureLockDir(tmpFresh);
    const st = await fs.lstat(freshDir);
    assert.equal(st.mode & 0o777, 0o700, "新規作成ロックディレクトリの権限が 0700 ではありません");
  } finally {
    await fs.chmod(tmpRo, 0o700).catch(() => {});
    await fs.rm(tmpBad, { recursive: true, force: true });
    await fs.rm(tmpFresh, { recursive: true, force: true });
    await fs.rm(tmpRo, { recursive: true, force: true });
  }
});

test("Medium: 死亡 PID の .reclaim スロットを削除せず deadTag+k ラダーで次スロットへ進み原子的に回収する", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-reclaim-ladder-"));
  const dead1 = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const dead2 = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await Promise.all([
    new Promise((res) => dead1.on("close", res)),
    new Promise((res) => dead2.on("close", res)),
  ]);
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000);"], { stdio: "ignore" });

  let lockPath;
  let slot0;
  let slot1;
  try {
    const targetPng = path.join(tmp, "out.png");
    const paths = await getTargetLockPaths(targetPng);
    lockPath = paths.lockPath;
    const { lockDir, hash } = paths;

    await fs.writeFile(
      lockPath,
      JSON.stringify({
        magic: "drawio-diagrams-lock-v1",
        pid: dead1.pid,
        nonce: "deadnonce1",
        createdAt: Date.now() - 1000,
      }),
      { mode: 0o600 }
    );
    const lst = await fs.lstat(lockPath);
    const deadTag = `${lst.dev}_${lst.ino}_deadnonce1`;
    slot0 = path.join(lockDir, `${hash}.reclaim-${deadTag}-0`);
    slot1 = path.join(lockDir, `${hash}.reclaim-${deadTag}-1`);

    await fs.writeFile(
      slot0,
      JSON.stringify({
        magic: "drawio-diagrams-reclaim-v1",
        pid: dead2.pid,
        nonce: "deadslot0",
        deadTag,
        slot: 0,
        createdAt: Date.now(),
      }),
      { mode: 0o600 }
    );
    await fs.writeFile(
      slot1,
      JSON.stringify({
        magic: "drawio-diagrams-reclaim-v1",
        pid: sleeper.pid,
        nonce: "aliveslot1",
        deadTag,
        slot: 1,
        createdAt: Date.now(),
      }),
      { mode: 0o600 }
    );

    let done = false;
    const pending = emitDiagramFiles({
      xml: "<mxfile/>",
      outPath: targetPng,
      convertPng: () => ({ png: Buffer.from("LADDER-OK"), width: 10, height: 10 }),
      convertSvg: () => ({ svg: "<svg/>", width: 10, height: 10 }),
    }).then(() => {
      done = true;
    });

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(done, false, "生存中のスロット1を無視して先へ進んでしまいました");
    assert.equal(fsSync.existsSync(slot0), true, "死亡スロット0を奪取前に削除してしまいました");
    assert.equal(fsSync.existsSync(slot1), true, "生存スロット1を奪取前に削除してしまいました");

    sleeper.kill("SIGKILL");
    await new Promise((res) => sleeper.on("close", res));

    await pending;
    assert.equal(await fs.readFile(targetPng, "utf8"), "LADDER-OK");
    assert.equal(fsSync.existsSync(lockPath), false, "回収後の本体ロックが解放されていません");
    assert.equal(fsSync.existsSync(slot0), false, "回収完了後に slot0 が残っています");
    assert.equal(fsSync.existsSync(slot1), false, "回収完了後に slot1 が残っています");
  } finally {
    sleeper.kill("SIGKILL");
    if (slot0) await fs.rm(slot0, { force: true }).catch(() => {});
    if (slot1) await fs.rm(slot1, { force: true }).catch(() => {});
    if (lockPath) await fs.rm(lockPath, { force: true }).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: POSIX で TMPDIR 環境変数が異なる 2 プロセス間でも同一ロックを共有して排他制御する", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX TMPDIR 独立共有ロックテスト");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-cross-tmpdir-"));
  const tmpA = path.join(tmp, "tmpA");
  const tmpB = path.join(tmp, "tmpB");
  await fs.mkdir(tmpA, { recursive: true });
  await fs.mkdir(tmpB, { recursive: true });
  const targetPng = path.join(tmp, "shared.png");
  const targetXml = path.join(tmp, "shared.drawio");
  const sharedUrl = pathToFileURL(path.join(ROOT, "scripts/diagram-shared.mjs")).href;

  let lockPathA = null;
  let childA = null;
  let childB = null;
  try {
    const scriptA = `
      import fs from "node:fs/promises";
      const { getTargetLockPaths } = await import(process.argv[1]);
      const { lockPath } = await getTargetLockPaths(process.argv[2]);
      await fs.writeFile(
        lockPath,
        JSON.stringify({ magic: "drawio-diagrams-lock-v1", pid: process.pid, nonce: "procA", createdAt: Date.now() }),
        { flag: "wx", mode: 0o600 }
      );
      process.stdout.write("READY:" + lockPath + "\\n");
      process.stdin.resume();
      const cleanup = async () => {
        await fs.rm(lockPath, { force: true }).catch(() => {});
        process.exit(0);
      };
      process.stdin.on("end", cleanup);
      process.on("SIGTERM", cleanup);
      setTimeout(cleanup, 10000).unref();
    `;
    childA = spawn(process.execPath, ["--input-type=module", "-e", scriptA, sharedUrl, targetPng], {
      env: { ...process.env, TMPDIR: tmpA },
      stdio: ["pipe", "pipe", "pipe"],
    });

    lockPathA = await new Promise((resolve, reject) => {
      let buf = "";
      let errBuf = "";
      childA.stderr.on("data", (d) => {
        errBuf += d.toString();
      });
      childA.stdout.on("data", (d) => {
        buf += d.toString();
        const m = buf.match(/^READY:(.+)\n/m);
        if (m) resolve(m[1]);
      });
      childA.on("close", (code) => {
        if (!buf.includes("READY:")) reject(new Error(`childA exited early (${code}): ${errBuf}`));
      });
    });

    const parentPaths = await getTargetLockPaths(targetPng);
    assert.equal(lockPathA, parentPaths.lockPath, "TMPDIR が異なるプロセスで lockPath が一致しません");
    assert.equal(lockPathA.startsWith(tmpA), false, "TMPDIR 配下にロックが分散しています");

    const scriptB = `
      const { emitDiagramFiles } = await import(process.argv[1]);
      await emitDiagramFiles({
        xml: "<mxfile>GEN-B</mxfile>",
        outPath: process.argv[2],
        xmlOutPath: process.argv[3],
        convertPng: () => ({ png: Buffer.from("PNG-B"), width: 10, height: 10 }),
        convertSvg: () => ({ svg: "<svg/>", width: 10, height: 10 }),
      });
    `;
    let childBExited = false;
    childB = spawn(
      process.execPath,
      ["--input-type=module", "-e", scriptB, sharedUrl, targetPng, targetXml],
      {
        env: { ...process.env, TMPDIR: tmpB },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let bErr = "";
    childB.stderr.on("data", (d) => {
      bErr += d.toString();
    });
    const bClosed = new Promise((resolve) => {
      childB.on("close", (code) => {
        childBExited = true;
        resolve(code);
      });
    });

    await new Promise((r) => setTimeout(r, 180));
    assert.equal(childBExited, false, "別 TMPDIR プロセスのロックを無視して書き込みが完了しました");
    assert.equal(fsSync.existsSync(targetPng), false, "ロック保持中に PNG が書き込まれました");

    childA.stdin.end();
    await new Promise((res) => childA.on("close", res));

    const codeB = await bClosed;
    assert.equal(codeB, 0, `childB failed: ${bErr}`);
    assert.equal(await fs.readFile(targetPng, "utf8"), "PNG-B");
    assert.equal(await fs.readFile(targetXml, "utf8"), "<mxfile>GEN-B</mxfile>");
  } finally {
    if (childA) childA.kill("SIGKILL");
    if (childB) childB.kill("SIGKILL");
    if (lockPathA) await fs.rm(lockPathA, { force: true }).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: macOS で未作成の Unicode NFC と NFD パス衝突を assertDistinctPaths と build-er CLI で検知する", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS Unicode NFC/NFD 正規化テスト");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-nfc-nfd-"));
  try {
    const nfcPng = path.join(tmp, "review-\u30ac.png");
    const nfdPng = path.join(tmp, "review-\u30ab\u3099.png");
    const upperNfdPng = path.join(tmp, "Review-\u30ab\u3099.PNG");

    assert.throws(
      () =>
        assertDistinctPaths([
          { role: "--xml-out", value: nfcPng },
          { role: "--output", value: nfdPng },
        ]),
      /衝突/
    );
    assert.throws(
      () =>
        assertDistinctPaths([
          { role: "--xml-out", value: nfcPng },
          { role: "--output", value: upperNfdPng },
        ]),
      /衝突/
    );
    assert.throws(
      () =>
        assertDistinctPaths([
          { role: "--json-out", value: path.join(tmp, "dir-\u30ac") },
          { role: "--output", value: path.join(tmp, "dir-\u30ab\u3099", "er.png") },
        ]),
      /親子パスで衝突/
    );

    const schemaSql = path.join(tmp, "schema.sql");
    await fs.writeFile(schemaSql, "CREATE TABLE users (id INT PRIMARY KEY);\n", "utf8");
    const res = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "scripts/build-er.mjs"),
        "--schema",
        schemaSql,
        "--xml-out",
        nfcPng,
        "--output",
        nfdPng,
      ],
      { cwd: tmp, encoding: "utf8" }
    );
    assert.notEqual(res.status, 0, "未作成 NFC/NFD 出力衝突を CLI が許可してしまいました");
    assert.match(res.stderr, /衝突/);
    assert.equal(fsSync.existsSync(nfcPng), false, "衝突時に NFC 出力が作成されました");
    assert.equal(fsSync.existsSync(nfdPng), false, "衝突時に NFD 出力が作成されました");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: export default Wrong.Sub や Wrong() 等の式で Wrong クラスへ誤結線しない", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-def-expr-"));
  try {
    for (const dir of ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "s12"]) {
      await fs.mkdir(path.join(tmp, dir), { recursive: true });
    }
    await fs.writeFile(
      path.join(tmp, "s1/mod.ts"),
      "export class Wrong { v: number = 1; }\nexport default Wrong.Sub;\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "s1/child.ts"),
      'import Parent from "./mod";\nexport class Child1 extends Parent {}\n',
      "utf8"
    );

    await fs.writeFile(
      path.join(tmp, "s2/mod.ts"),
      "export class Wrong { v: number = 2; }\nexport default Wrong();\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "s2/child.ts"),
      'import Parent from "./mod";\nexport class Child2 extends Parent {}\n',
      "utf8"
    );

    await fs.writeFile(
      path.join(tmp, "s3/mod.ts"),
      "export class Wrong { v: number = 3; }\nexport default Wrong\n  .Sub;\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "s3/child.ts"),
      'import Parent from "./mod";\nexport class Child3 extends Parent {}\n',
      "utf8"
    );

    await fs.writeFile(
      path.join(tmp, "s4/mod.ts"),
      "export class Actual { v: number = 4; }\nexport default Actual as typeof Actual;\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "s4/child.ts"),
      'import Parent from "./mod";\nexport class Child4 extends Parent {}\n',
      "utf8"
    );

    await fs.writeFile(
      path.join(tmp, "s5/mod.js"),
      "class Wrong { constructor() { this.v = 5; } }\nmodule.exports = Wrong.Sub;\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "s5/child.ts"),
      'import Parent from "./mod";\nexport class Child5 extends Parent {}\n',
      "utf8"
    );

    await fs.writeFile(
      path.join(tmp, "s6/mod.ts"),
      "export class Wrong { v: number = 6; }\nexport default Wrong\n\n  .Sub;\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "s6/child.ts"),
      'import Parent from "./mod";\nexport class Child6 extends Parent {}\n',
      "utf8"
    );

    await fs.writeFile(
      path.join(tmp, "s7/mod.ts"),
      "export class Wrong { v: number = 7; }\nexport default Wrong\n/* comment */\n  .Sub;\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "s7/child.ts"),
      'import Parent from "./mod";\nexport class Child7 extends Parent {}\n',
      "utf8"
    );

    await fs.writeFile(
      path.join(tmp, "s8/mod.js"),
      "class Wrong { constructor() { this.v = 8; } }\nmodule.exports = Wrong\n\n  .Sub;\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "s8/child.ts"),
      'import Parent from "./mod";\nexport class Child8 extends Parent {}\n',
      "utf8"
    );

    await fs.writeFile(
      path.join(tmp, "s9/mod.ts"),
      "export class ActualTwo { v: number = 9; }\nexport default ActualTwo\n\ninterface INext {}\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "s9/child.ts"),
      'import Parent from "./mod";\nexport class Child9 extends Parent {}\n',
      "utf8"
    );

    await fs.writeFile(
      path.join(tmp, "s10/mod.ts"),
      "export class Wrong { v: number = 10; }\nexport default Wrong as typeof Wrong && Actual;\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "s10/child.ts"),
      'import Parent from "./mod";\nexport class Child10 extends Parent {}\n',
      "utf8"
    );

    await fs.writeFile(
      path.join(tmp, "s11/mod.ts"),
      "export class Wrong { v: number = 11; }\nexport default Wrong as any || Actual;\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "s11/child.ts"),
      'import Parent from "./mod";\nexport class Child11 extends Parent {}\n',
      "utf8"
    );

    await fs.writeFile(
      path.join(tmp, "s12/mod.ts"),
      "export class ActualThree { v: number = 12; }\nexport default ActualThree as unknown as ActualThree;\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tmp, "s12/child.ts"),
      'import Parent from "./mod";\nexport class Child12 extends Parent {}\n',
      "utf8"
    );

    const spec = await scanDirectory(tmp, {});
    for (const cname of [
      "Child1",
      "Child2",
      "Child3",
      "Child5",
      "Child6",
      "Child7",
      "Child8",
      "Child10",
      "Child11",
    ]) {
      const badRel = spec.relations.find((r) => r.from === cname && r.type === "inheritance");
      assert.equal(badRel, undefined, `${cname} が式ベース default export で誤結線しました: ${JSON.stringify(badRel)}`);
    }
    const okRel = spec.relations.find((r) => r.from === "Child4" && r.type === "inheritance");
    assert.ok(okRel, `export default Actual as ... が解決できません: ${JSON.stringify(spec.relations)}`);
    assert.equal(spec.classes.find((c) => c.id === okRel.to).name, "Actual");

    const okRel2 = spec.relations.find((r) => r.from === "Child9" && r.type === "inheritance");
    assert.ok(okRel2, `export default ActualTwo\\n\\ninterface が解決できません: ${JSON.stringify(spec.relations)}`);
    assert.equal(spec.classes.find((c) => c.id === okRel2.to).name, "ActualTwo");

    const okRel3 = spec.relations.find((r) => r.from === "Child12" && r.type === "inheritance");
    assert.ok(okRel3, `export default ActualThree as unknown as ... が解決できません: ${JSON.stringify(spec.relations)}`);
    assert.equal(spec.classes.find((c) => c.id === okRel3.to).name, "ActualThree");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Low: lockPath に FIFO が事前配置されていても別プロセスでハングせず EINVAL で即拒否する", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX FIFO ロックテスト");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-lock-fifo-"));
  let lockPath = null;
  let child = null;
  try {
    const targetPng = path.join(tmp, "fifo-out.png");
    ({ lockPath } = await getTargetLockPaths(targetPng));
    await fs.rm(lockPath, { force: true });
    const mk = spawnSync("mkfifo", [lockPath], { encoding: "utf8" });
    if (mk.error || mk.status !== 0) {
      t.skip("mkfifo コマンドが利用できないためスキップ");
      return;
    }

    const sharedUrl = pathToFileURL(path.join(ROOT, "scripts/diagram-shared.mjs")).href;
    const script = `
      const { emitDiagramFiles } = await import(process.argv[1]);
      try {
        await emitDiagramFiles({
          xml: "<mxfile/>",
          outPath: process.argv[2],
          convertPng: () => ({ png: Buffer.from("P"), width: 10, height: 10 }),
          convertSvg: () => ({ svg: "<svg/>", width: 10, height: 10 }),
        });
        process.stdout.write("UNEXPECTED_OK\\n");
        process.exit(2);
      } catch (err) {
        process.stdout.write("ERR:" + (err && err.code ? err.code : String(err)) + "\\n");
        process.exit(0);
      }
    `;

    let timedOut = false;
    child = spawn(process.execPath, ["--input-type=module", "-e", script, sharedUrl, targetPng], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      errOut += d.toString();
    });

    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 3000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    assert.equal(timedOut, false, `FIFO でハングしタイムアウト強制終了しました (${out} / ${errOut})`);
    assert.equal(exitCode, 0, `子プロセスが異常終了しました: code=${exitCode} out=${out} err=${errOut}`);
    assert.equal(out.trim(), "ERR:EINVAL");
  } finally {
    if (child) child.kill("SIGKILL");
    if (lockPath) await fs.rm(lockPath, { force: true }).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: 0 バイトの空ロックは 120 秒経過していても古いロックとして奪取せず EEXIST で拒否する", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-empty-lock-"));
  let lockPath = null;
  try {
    const targetPng = path.join(tmp, "empty.png");
    ({ lockPath } = await getTargetLockPaths(targetPng));
    await fs.writeFile(lockPath, "", { mode: 0o600 });
    const oldTime = new Date(Date.now() - 120 * 1000);
    await fs.utimes(lockPath, oldTime, oldTime);

    await assert.rejects(
      () =>
        emitDiagramFiles({
          xml: "<mxfile/>",
          outPath: targetPng,
          convertPng: () => ({ png: Buffer.from("P"), width: 10, height: 10 }),
          convertSvg: () => ({ svg: "<svg/>", width: 10, height: 10 }),
        }),
      (err) => err && err.code === "EEXIST"
    );
  } finally {
    if (lockPath) await fs.rm(lockPath, { force: true }).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Low: 死亡 PID の .reclaim スロットが 32 個を超えて存在してもラダーで回収し全スロットを片付ける", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-reclaim-35-"));
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((res) => dead.on("close", res));

  let lockPath = null;
  const createdSlots = [];
  try {
    const targetPng = path.join(tmp, "unbounded.png");
    const { lockDir, lockPath: lp, hash } = await getTargetLockPaths(targetPng);
    lockPath = lp;

    await fs.writeFile(
      lockPath,
      JSON.stringify({
        magic: "drawio-diagrams-lock-v1",
        pid: dead.pid,
        nonce: "deadmany",
        createdAt: Date.now() - 1000,
      }),
      { mode: 0o600 }
    );
    const lst = await fs.lstat(lockPath);
    const deadTag = `${lst.dev}_${lst.ino}_deadmany`;

    for (let k = 0; k < 35; k += 1) {
      const slotPath = path.join(lockDir, `${hash}.reclaim-${deadTag}-${k}`);
      createdSlots.push(slotPath);
      await fs.writeFile(
        slotPath,
        JSON.stringify({
          magic: "drawio-diagrams-reclaim-v1",
          pid: dead.pid,
          nonce: `deadslot-${k}`,
          deadTag,
          slot: k,
          createdAt: Date.now(),
        }),
        { mode: 0o600 }
      );
    }

    await emitDiagramFiles({
      xml: "<mxfile/>",
      outPath: targetPng,
      convertPng: () => ({ png: Buffer.from("UNBOUNDED-OK"), width: 10, height: 10 }),
      convertSvg: () => ({ svg: "<svg/>", width: 10, height: 10 }),
    });

    assert.equal(await fs.readFile(targetPng, "utf8"), "UNBOUNDED-OK");
    assert.equal(fsSync.existsSync(lockPath), false, "回収後のロックが残っています");
    for (const sp of createdSlots) {
      assert.equal(fsSync.existsSync(sp), false, `先行スロット ${sp} が片付けられていません`);
    }
    assert.equal(
      fsSync.existsSync(path.join(lockDir, `${hash}.reclaim-${deadTag}-35`)),
      false,
      "取得に使用したスロット 35 が残っています"
    );
  } finally {
    for (const sp of createdSlots) await fs.rm(sp, { force: true }).catch(() => {});
    if (lockPath) await fs.rm(lockPath, { force: true }).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: Step Functions JSONata の Arguments.FunctionName を Invoke エッジとして接続し、Payload 内や Pass は誤結線しない", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-sfn-jsonata-"));
  const TF = `
resource "aws_lambda_function" "worker" {
  function_name = "worker"
}
resource "aws_lambda_function" "mailer" {
  function_name = "mailer"
}
resource "aws_lambda_function" "ignored" {
  function_name = "ignored"
}

resource "aws_sfn_state_machine" "jsonata_hcl" {
  definition = jsonencode({
    StartAt = "Run"
    States = {
      Run = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Arguments = {
          FunctionName = aws_lambda_function.worker.arn
          Payload = {
            FunctionName = aws_lambda_function.mailer.arn
          }
        }
        Next = "After"
      }
      After = {
        Type = "Pass"
        Arguments = {
          FunctionName = aws_lambda_function.ignored.arn
        }
        End = true
      }
    }
  })
}

resource "aws_sfn_state_machine" "jsonata_json" {
  definition = <<EOF
{
  "StartAt": "Run",
  "States": {
    "Run": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Arguments": {
        "FunctionName": "\${aws_lambda_function.worker.arn}",
        "Payload": {
          "FunctionName": "\${aws_lambda_function.mailer.arn}"
        }
      },
      "Next": "After"
    },
    "After": {
      "Type": "Pass",
      "Arguments": {
        "FunctionName": "\${aws_lambda_function.ignored.arn}"
      },
      "End": true
    }
  }
}
EOF
}
resource "aws_sfn_state_machine" "get_fn_hcl" {
  definition = jsonencode({
    StartAt = "Inspect"
    States = {
      Inspect = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:lambda:getFunction"
        Arguments = {
          FunctionName = aws_lambda_function.worker.arn
        }
        End = true
      }
    }
  })
}

resource "aws_sfn_state_machine" "get_fn_param" {
  definition = jsonencode({
    StartAt = "InspectParam"
    States = {
      InspectParam = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:lambda:getFunction"
        Parameters = {
          FunctionName = aws_lambda_function.worker.arn
        }
        End = true
      }
    }
  })
}

resource "aws_sfn_state_machine" "sdk_invoke_jsonata" {
  definition = jsonencode({
    StartAt = "InvokeSdk"
    States = {
      InvokeSdk = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:lambda:invoke"
        Arguments = {
          FunctionName = aws_lambda_function.worker.arn
        }
        End = true
      }
    }
  })
}
`;
  try {
    await fs.writeFile(path.join(tmp, "main.tf"), TF, "utf8");
    const spec = await scanTerraformDirectory(tmp, {});
    const labelsFrom = (id) =>
      spec.edges.filter((e) => e.from === id).map((e) => `${e.to}=${e.label}`);

    for (const smId of [
      "aws_sfn_state_machine_jsonata_hcl",
      "aws_sfn_state_machine_jsonata_json",
      "aws_sfn_state_machine_sdk_invoke_jsonata",
    ]) {
      const edges = labelsFrom(smId);
      assert.ok(
        edges.includes("aws_lambda_function_worker=Invoke"),
        `${smId} の Arguments.FunctionName が Invoke になりません: ${JSON.stringify(edges)}`
      );
      assert.ok(
        !edges.some((e) => e.startsWith("aws_lambda_function_mailer")),
        `${smId} の Arguments.Payload.FunctionName が誤結線しました: ${JSON.stringify(edges)}`
      );
      assert.ok(
        !edges.some((e) => e.startsWith("aws_lambda_function_ignored")),
        `${smId} の Pass.Arguments.FunctionName が誤結線しました: ${JSON.stringify(edges)}`
      );
    }

    for (const nonInvokeSm of ["aws_sfn_state_machine_get_fn_hcl", "aws_sfn_state_machine_get_fn_param"]) {
      const edges = labelsFrom(nonInvokeSm);
      assert.equal(
        edges.length,
        0,
        `${nonInvokeSm} (aws-sdk:lambda:getFunction) に Invoke エッジが付きました: ${JSON.stringify(edges)}`
      );
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: export * from を 20 兄弟モジュール並べて最後だけが公開しても継承を解決する", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-star-siblings-"));
  try {
    const barrelLines = [];
    for (let i = 1; i <= 20; i += 1) {
      const mod = `m${String(i).padStart(2, "0")}`;
      barrelLines.push(`export * from "./${mod}";`);
      const body =
        i === 20
          ? "export class Base { v: number = 20; }\n"
          : `export class Helper${i} { n: number = ${i}; }\n`;
      await fs.writeFile(path.join(tmp, `${mod}.ts`), body, "utf8");
    }
    await fs.writeFile(path.join(tmp, "index.ts"), barrelLines.join("\n") + "\n", "utf8");
    await fs.writeFile(
      path.join(tmp, "child.ts"),
      'import { Base } from "./index";\nexport class Child extends Base {}\n',
      "utf8"
    );

    const spec = await scanDirectory(tmp, {});
    const rel = spec.relations.find((r) => r.from === "Child" && r.type === "inheritance");
    assert.ok(rel, `20 兄弟モジュール末の export * が解決できません: ${JSON.stringify(spec.relations)}`);
    assert.equal(spec.classes.find((c) => c.id === rel.to).name, "Base");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: drawio2png --all-pages はページ間の未作成親子衝突（Page2 symlink -> Page1/child.png）を 1 ページ目作成前に拒否する", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX symlink 親子衝突テスト");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-allpages-ancestor-"));
  try {
    const twoPageXml =
      '<mxfile>' +
      '<diagram id="p1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="a" value="P1" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="20" y="20" width="80" height="40" as="geometry"/></mxCell>' +
      "</root></mxGraphModel></diagram>" +
      '<diagram id="p2" name="Page-2"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="b" value="P2" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="20" y="20" width="80" height="40" as="geometry"/></mxCell>' +
      "</root></mxGraphModel></diagram>" +
      "</mxfile>";
    const inFile = path.join(tmp, "multi.drawio");
    await fs.writeFile(inFile, twoPageXml, "utf8");
    const page1Out = path.join(tmp, "out-1-Page-1.png");
    const page2Out = path.join(tmp, "out-2-Page-2.png");
    await fs.symlink(path.join("out-1-Page-1.png", "child.png"), page2Out);

    const r = runScript("drawio2png.mjs", ["multi.drawio", "--all-pages", "-o", "out.png"], tmp);
    assert.notEqual(r.status, 0, "--all-pages 親子衝突が成功してしまいました");
    assert.match(r.stderr, /親子パスで衝突/);
    assert.equal(fsSync.existsSync(page1Out), false, "親子衝突検出前にページ1が作成されました");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Medium: drawio2png はシンボリックリンク入力で -o 省略時にリンク配置ディレクトリ・リンク名で出力しリンク先画像を上書きしない", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX symlink テスト");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-symlink-default-out-"));
  try {
    const assetsDir = path.join(tmp, "assets");
    const workDir = path.join(tmp, "work");
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });

    const twoPageXml =
      '<mxfile>' +
      '<diagram id="p1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="a" value="P1" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="20" y="20" width="80" height="40" as="geometry"/></mxCell>' +
      "</root></mxGraphModel></diagram>" +
      '<diagram id="p2" name="Page-2"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="b" value="P2" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="20" y="20" width="80" height="40" as="geometry"/></mxCell>' +
      "</root></mxGraphModel></diagram>" +
      "</mxfile>";
    const sourceDrawio = path.join(assetsDir, "source.drawio");
    const sourcePng = path.join(assetsDir, "source.png");
    await fs.writeFile(sourceDrawio, twoPageXml, "utf8");
    await fs.writeFile(sourcePng, "DO_NOT_OVERWRITE", "utf8");

    const aliasDrawio = path.join(workDir, "alias.drawio");
    await fs.symlink(path.join("..", "assets", "source.drawio"), aliasDrawio);

    const rSingle = runScript("drawio2png.mjs", ["work/alias.drawio"], tmp);
    assert.equal(rSingle.status, 0, `symlink 既定出力が失敗しました:\n${rSingle.stderr}`);
    assert.equal(fsSync.existsSync(path.join(workDir, "alias.png")), true, "work/alias.png が生成されていません");
    assert.equal(await fs.readFile(sourcePng, "utf8"), "DO_NOT_OVERWRITE", "リンク先 assets/source.png が上書きされました");

    const rAll = runScript("drawio2png.mjs", ["work/alias.drawio", "--all-pages"], tmp);
    assert.equal(rAll.status, 0, `symlink --all-pages 既定出力が失敗しました:\n${rAll.stderr}`);
    assert.equal(fsSync.existsSync(path.join(workDir, "alias-1-Page-1.png")), true, "work/alias-1-Page-1.png が生成されていません");
    assert.equal(fsSync.existsSync(path.join(workDir, "alias-2-Page-2.png")), true, "work/alias-2-Page-2.png が生成されていません");
    assert.equal(fsSync.existsSync(path.join(assetsDir, "source-1-Page-1.png")), false, "リンク先に --all-pages 出力が漏れました");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Low: stageTempFile は 255 バイト付近の長い出力ファイル名でも ENAMETOOLONG を起こさず一時ファイルを残さない", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-namemax-"));
  try {
    const longXml = path.join(tmp, `${"a".repeat(243)}.drawio`);
    const longPng = path.join(tmp, `${"a".repeat(246)}.png`);
    await emitDiagramFiles({
      xml: "<mxfile>LONG</mxfile>",
      outPath: longPng,
      xmlOutPath: longXml,
      convertPng: () => ({ png: Buffer.from("LONG-PNG"), width: 10, height: 10 }),
      convertSvg: () => ({ svg: "<svg/>", width: 10, height: 10 }),
    });
    assert.equal(await fs.readFile(longXml, "utf8"), "<mxfile>LONG</mxfile>");
    assert.equal(await fs.readFile(longPng, "utf8"), "LONG-PNG");

    const entries = await fs.readdir(tmp);
    const leftovers = entries.filter((e) => e.includes(".tmp-"));
    assert.deepEqual(leftovers, [], `一時ファイルが残っています: ${JSON.stringify(leftovers)}`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
