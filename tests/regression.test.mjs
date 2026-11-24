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
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertDistinctPaths, inspectXmlCells } from "../scripts/diagram-shared.mjs";
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

test("scan-schema: 既定で symlink を辿らず、循環・切断リンクでも落ちない", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drawio-scan-"));
  try {
    const inside = path.join(tmp, "schema");
    const outside = path.join(tmp, "outside");
    await fs.mkdir(inside, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(inside, "a.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY);\n");
    await fs.writeFile(path.join(outside, "b.sql"), "CREATE TABLE b (id INTEGER PRIMARY KEY);\n");
    // ルート内の別ディレクトリへ出るリンク / ルート外へ出るリンク / 切断リンク / 循環リンク
    await fs.symlink(path.join(tmp, "outside"), path.join(inside, "escape"));
    await fs.symlink(path.join(inside, "a.sql"), path.join(inside, "link.sql"));
    await fs.symlink(path.join(inside, "nowhere.sql"), path.join(inside, "broken.sql"));
    await fs.symlink(inside, path.join(inside, "self"));

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

test("drawio2png.mjs / NOTICE / README: MPL-2.0 対象領域の境界と Source Code Form の所在が実装と一致する", () => {
  const src = readText(path.join(ROOT, "scripts", "drawio2png.mjs"));
  const notice = readText(path.join(ROOT, "NOTICE"));
  const readme = readText(path.join(ROOT, "README.md"));
  const BEGIN = "// BEGIN MPL-2.0 COVERED SOFTWARE (@resvg/resvg-wasm v2.6.2)";
  const END = "// END MPL-2.0 COVERED SOFTWARE (@resvg/resvg-wasm v2.6.2)";

  // ライセンスヘッダより後ろ（実コード）で BEGIN / END が対になっている
  const code = src.slice(src.indexOf("\n */\n") + 5);
  const regions = code.split(BEGIN).slice(1).map((chunk) => chunk.split(END)[0]);
  assert.equal(regions.length, code.split(END).length - 1, "MPL-2.0 の BEGIN / END マーカーが対になっていません");
  assert.ok(regions.length >= 2, "MPL-2.0 の対象領域がマーカーで囲まれていません");

  // 囲まれているのは「wasm の base64」と「wasm-bindgen グルー」だけ
  assert.ok(
    regions.some((r) => r.includes("const EMBEDDED_RESVG_WASM_B64")),
    "EMBEDDED_RESVG_WASM_B64 が MPL-2.0 の対象領域として囲まれていません"
  );
  assert.ok(
    regions.some((r) => r.includes("__wbg_finalize_init") && r.includes("isCustomFontsOptions")),
    "wasm-bindgen の同期初期化グルーが MPL-2.0 の対象領域として囲まれていません"
  );
  assert.ok(
    !regions.some((r) => r.includes("EMBEDDED_SHAPES_B64") || r.includes("EMBEDDED_STENCILS_MAP")),
    "Apache-2.0 側の draw.io アセットが MPL-2.0 の対象領域に巻き込まれています"
  );
  const afterMarkers = code.slice(code.lastIndexOf(END));
  assert.ok(
    afterMarkers.includes("__getResvgRenderer"),
    "自前のコンバーターコードが MPL-2.0 の対象領域の内側に残っています"
  );

  // Source Code Form の所在（このファイル自体が修正版のソース）と来歴 URL
  assert.match(src, /Larger Work[\s\S]{0,200}section 3\.3|section 3\.3[\s\S]{0,200}Larger Work/);
  assert.match(src, /WHERE THE SOURCE CODE FORM OF THE MODIFIED GLUE IS AVAILABLE/);
  assert.match(src, /readable, unobfuscated, uncompressed JavaScript/);
  assert.match(src, /https:\/\/github\.com\/thx\/resvg-js\/tree\/v2\.6\.2/);
  assert.match(
    src,
    /https:\/\/github\.com\/jgraph\/drawio\/tree\/v29\.6\.6/,
    "Apache-2.0 部（draw.io アセット）の上流 URL がヘッダにありません"
  );
  assert.match(src, /https:\/\/www\.mozilla\.org\/en-US\/MPL\/2\.0\//);

  // NOTICE / README も同じ内容に揃えている（上流だけに依存した記述に戻していない）
  assert.ok(notice.includes("BEGIN MPL-2.0 COVERED SOFTWARE"), "NOTICE に境界マーカーの記述がありません");
  assert.match(notice, /modified Source Code Form is distributed with this product/i);
  assert.match(notice, /Larger Work \/ Combined\s*\n?\s*distribution/i, "NOTICE に MPL-2.0 §3.3 の位置づけがありません");
  assert.ok(
    !/corresponding Source Code Form remains available upstream/.test(notice),
    "NOTICE が修正版の Source Code Form を上流依存だけと書いています"
  );
  assert.match(readme, /BEGIN MPL-2\.0 COVERED SOFTWARE/);
  assert.match(readme, /そのものが修正版の\s*Source Code Form/);
  assert.match(readme, /Larger Work/);
  assert.ok(
    !/Source Code Form は\s*上の来歴 URL に公開/.test(readme),
    "README が修正版の Source Code Form を上流 URL のみに公開している記述に戻っています"
  );
});
