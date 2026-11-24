#!/usr/bin/env node
/**
 * build-class.mjs — UML クラス図生成 CLI (Pure Node.js / ゼロ依存)
 *
 * JSON spec (--spec) または TypeScript / JavaScript ソースディレクトリ
 * (--src-dir) から、モダンな UML クラス図 `.drawio` XML を生成し、
 * 同梱の `drawio2png.mjs` で `.drawio.png`（XML埋め込み済み）または `.svg` に変換する。
 *
 * 使用例:
 *   node scripts/build-class.mjs --spec examples/order-domain.json \
 *     --output examples/output/order-domain-class.drawio.png
 *   node scripts/build-class.mjs --src-dir ./src --output out/class.drawio.png
 *
 * 詳細は references/spec-schema.md を参照。
 */

import fsSync from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { convertXmlToPng, convertXmlToSvg } from "./drawio2png.mjs";
import {
  assertOutputsDistinctFromInputs,
  createCellIdMap,
  emitDiagramFiles,
  expandInputPaths,
  isDirectRun,
} from "./diagram-shared.mjs";
import { scanDirectory } from "./scan-classes.mjs";

// ---------------------------------------------------------------------------
// テーマパレット
// ---------------------------------------------------------------------------

/** stereotype ごとのヘッダー色 / 枠色 / 名前のイタリック有無 */
const PALETTE = {
  interface: { headerFill: "#CCFBF1", stroke: "#0D9488", italic: false },
  abstract: { headerFill: "#F3E8FF", stroke: "#7C3AED", italic: true },
  enum: { headerFill: "#FEF3C7", stroke: "#D97706", italic: false },
  "value object": { headerFill: "#E0F2FE", stroke: "#0284C7", italic: false },
  dto: { headerFill: "#E0F2FE", stroke: "#0284C7", italic: false },
  entity: { headerFill: "#EEF2FF", stroke: "#3730A3", italic: false },
  service: { headerFill: "#EEF2FF", stroke: "#3730A3", italic: false },
  default: { headerFill: "#EEF2FF", stroke: "#3730A3", italic: false },
};

const ACCENT = "#4F46E5";
const TITLE_COLOR = "#0F172A";
const SUBTITLE_COLOR = "#475569";
const DIVIDER_COLOR = "#E2E8F0";
const SECTION_DIVIDER = "#E2E8F0";
const MEMBER_COLOR = "#334155";
const PACKAGE_FILL = "#F8FAFC";
const PACKAGE_STROKE = "#94A3B8";

/** 自動配置のティア（row 未指定時に使用） */
const TIER_BY_STEREOTYPE = {
  interface: 0,
  abstract: 0,
  entity: 1,
  service: 1,
  default: 1,
  enum: 2,
  "value object": 2,
  dto: 2,
};

const H_GAP = 90; // カード間の横ギャップ (px)
const V_GAP = 80; // カード間の縦ギャップ (px)
const CHAR_W = 6.3; // メンバー行 (11px) の 1 文字当たり概算幅
const NAME_CHAR_W = 7.8; // クラス名 (13px bold) の 1 文字当たり概算幅
const LINE_H = 18;
const MIN_W = 190;
const MAX_W = 340;

const HELP_TEXT = `
build-class.mjs - UML class diagram generator (.drawio + .drawio.png / .svg), zero dependency

Usage:
  node build-class.mjs (--spec <spec.json> | --src-dir <dir>) [options]

Options:
  --spec <path>         JSON spec file (see references/spec-schema.md)
  --src-dir <dir>       Scan TypeScript / JavaScript sources into a spec first
  -o, --output <path>   Output file: *.drawio.png (default) or *.svg
      --xml-out <path>  Where to write the intermediate .drawio XML
                        (default: <output> without .png/.svg suffix)
      --name <name>     Diagram (page) name (default: spec title or "Class Diagram")
      --title <text>    Override diagram title
      --subtitle <text> Override diagram subtitle
      --scale <number>  PNG scale factor (default: 2)
      --no-png          Write only the .drawio XML, skip PNG/SVG conversion
  -h, --help            Show this help message
`.trim();

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * html=1 ラベルに入れる生テキスト用。
 * draw.io ラベルは HTML として解釈されるため、`<void>` などがタグとして
 * 消えないよう二重にエスケープする（XML パース後に &lt; として復元される）。
 */
function escMember(s) {
  return esc(
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  );
}

function clamp(min, v, max) {
  return Math.max(min, Math.min(max, v));
}

function normalizeStereotype(st) {
  if (!st) return "default";
  const key = String(st).trim().toLowerCase();
  if (key === "valueobject" || key === "value-object" || key === "vo") {
    return "value object";
  }
  return key in PALETTE ? key : key === "" ? "default" : key;
}

function paletteFor(stereotype) {
  return PALETTE[normalizeStereotype(stereotype)] || PALETTE.default;
}

function tierFor(stereotype) {
  return TIER_BY_STEREOTYPE[normalizeStereotype(stereotype)] ?? 1;
}

// 元 ID → 一意な内部セル ID の対応表は buildDiagramXml() 内で createCellIdMap() から作る。
// 非 ASCII ID（日本語クラス名など）や記号違い（`a.b` / `a/b`）が同じ正規形に
// 潰れて衝突しないため、重複時は連番を付けて区別する。

// ---------------------------------------------------------------------------
// ノードサイズ計測
// ---------------------------------------------------------------------------

function wrapCount(line, maxChars) {
  if (maxChars <= 0) return 1;
  return Math.max(1, Math.ceil(line.length / maxChars));
}

function measureNode(node) {
  const attrs = node.attributes || [];
  const methods = node.methods || [];
  const stereo = normalizeStereotype(node.stereotype);
  const hasStereo = stereo !== "default";

  const memberLines = [...attrs, ...methods];
  const longest = memberLines.reduce((m, l) => Math.max(m, String(l).length), 0);
  const nameW = String(node.name).length * NAME_CHAR_W + 48;
  const memberW = longest * CHAR_W + 40;
  const width = clamp(MIN_W, Math.max(nameW, memberW), MAX_W);

  const maxChars = Math.floor((width - 26) / CHAR_W);
  const attrLines = attrs.reduce((s, l) => s + wrapCount(String(l), maxChars), 0);
  const methLines = methods.reduce((s, l) => s + wrapCount(String(l), maxChars), 0);

  const headerH = hasStereo ? 42 : 30;
  const attrH = attrLines > 0 ? attrLines * LINE_H + 10 : 0;
  const methH = methLines > 0 ? methLines * LINE_H + 10 : 0;
  const sepH = attrH > 0 && methH > 0 ? 1 : 0;
  const height = headerH + attrH + sepH + methH + 4;

  return {
    id: node.id || node.name,
    ...node,
    attributes: attrs,
    methods,
    stereo,
    width,
    height: Math.max(height, headerH + 26),
    headerH,
    attrH,
    methH,
    x: 0,
    y: 0,
  };
}

// ---------------------------------------------------------------------------
// グリッドレイアウト
// ---------------------------------------------------------------------------

function layoutGrid(nodes) {
  // row / col を決定（明示指定を優先し、未指定はティアから自動配置）
  const explicitRows = nodes
    .filter((n) => Number.isInteger(n.row))
    .map((n) => n.row);
  const maxExplicitRow = explicitRows.length ? Math.max(...explicitRows) : -1;
  const tierRows = [0, 1, 2].map((t) => maxExplicitRow + 1 + t);

  for (const n of nodes) {
    if (!Number.isInteger(n.row)) n.row = tierRows[tierFor(n.stereo)];
    n._autoCol = true;
  }

  // col を決定（row 単位で明示 col を確保 → 残りを空き col に詰める）
  const byRow = new Map();
  for (const n of nodes) {
    if (!byRow.has(n.row)) byRow.set(n.row, []);
    byRow.get(n.row).push(n);
  }
  for (const [, rowNodes] of byRow) {
    const usedCols = new Set(rowNodes.filter((n) => Number.isInteger(n.col)).map((n) => n.col));
    let nextCol = 0;
    for (const n of rowNodes) {
      if (Number.isInteger(n.col)) {
        n._col = n.col;
      } else {
        while (usedCols.has(nextCol)) nextCol += 1;
        n._col = nextCol;
        usedCols.add(nextCol);
      }
    }
  }

  const cols = [...new Set(nodes.map((n) => n._col))].sort((a, b) => a - b);
  const rows = [...new Set(nodes.map((n) => n.row))].sort((a, b) => a - b);

  const colW = new Map();
  const rowH = new Map();
  for (const n of nodes) {
    colW.set(n._col, Math.max(colW.get(n._col) || 0, n.width));
    rowH.set(n.row, Math.max(rowH.get(n.row) || 0, n.height));
  }

  const colX = new Map();
  let x = 0;
  for (const c of cols) {
    colX.set(c, x);
    x += colW.get(c) + H_GAP;
  }
  const rowY = new Map();
  let y = 0;
  for (const r of rows) {
    rowY.set(r, y);
    y += rowH.get(r) + V_GAP;
  }

  for (const n of nodes) {
    n.x = colX.get(n._col) + (colW.get(n._col) - n.width) / 2;
    n.y = rowY.get(n.row) + (rowH.get(n.row) - n.height) / 2;
  }

  const width = (x > 0 ? x - H_GAP : 0) || 1;
  const height = (y > 0 ? y - V_GAP : 0) || 1;
  return { width, height };
}

// ---------------------------------------------------------------------------
// エッジ（リレーションシップ）
// ---------------------------------------------------------------------------

const RELATION_ALIASES = {
  extends: "inheritance",
  generalization: "inheritance",
  implements: "implementation",
  realize: "implementation",
  uses: "dependency",
};

const RELATION_STYLE = {
  inheritance: "endArrow=block;endFill=0;endSize=10;",
  implementation: "dashed=1;dashPattern=5 3;endArrow=block;endFill=0;endSize=10;",
  composition:
    "startArrow=diamondThin;startFill=1;startSize=10;endArrow=open;endSize=8;",
  aggregation:
    "startArrow=diamondThin;startFill=0;startSize=10;endArrow=open;endSize=8;",
  association: "endArrow=open;endSize=8;",
  dependency: "dashed=1;dashPattern=5 3;endArrow=open;endSize=8;",
};

const RELATION_STROKE = {
  inheritance: "#1E293B",
  implementation: "#0D9488",
  composition: "#1E293B",
  aggregation: "#475569",
  association: "#334155",
  dependency: "#64748B",
};

function normalizeRelationType(t) {
  const key = String(t || "association").trim().toLowerCase();
  const resolved = RELATION_ALIASES[key] || key;
  return resolved in RELATION_STYLE ? resolved : "association";
}

/** 端子（ポート）をノード位置関係から決め、同一辺上の分散を行う */
function assignPorts(nodesById, relations) {
  const sideCount = new Map(); // "nodeId|side" -> count
  const sideIndex = new Map();
  const pending = [];

  for (const rel of relations) {
    const s = nodesById.get(rel.from);
    const t = nodesById.get(rel.to);
    if (!s || !t) continue;

    const dx = t.x + t.width / 2 - (s.x + s.width / 2);
    const dy = t.y + t.height / 2 - (s.y + s.height / 2);

    let exitSide, entrySide;
    if (Math.abs(dy) >= Math.abs(dx) * 0.9 && Math.abs(dy) >= 40) {
      exitSide = dy > 0 ? "bottom" : "top";
      entrySide = dy > 0 ? "top" : "bottom";
    } else {
      exitSide = dx > 0 ? "right" : "left";
      entrySide = dx > 0 ? "left" : "right";
    }

    for (const [node, side] of [
      [s, exitSide],
      [t, entrySide],
    ]) {
      const key = `${node.id}|${side}`;
      sideCount.set(key, (sideCount.get(key) || 0) + 1);
    }
    pending.push({ rel, exitSide, entrySide });
  }

  const fracFor = (key, side) => {
    const count = sideCount.get(key) || 1;
    const idx = sideIndex.get(key) || 0;
    sideIndex.set(key, idx + 1);
    if (count === 1) return 0.5;
    return 0.3 + (0.4 * idx) / (count - 1);
  };

  for (const { rel, exitSide, entrySide } of pending) {
    rel.exitSide = exitSide;
    rel.entrySide = entrySide;
    rel.exitFrac = fracFor(`${rel.from}|${exitSide}`, exitSide);
    rel.entryFrac = fracFor(`${rel.to}|${entrySide}`, entrySide);
  }
  return pending.map((p) => p.rel);
}

/** 直線経路上に他カードがあるか（水平方向の辺を持つエッジ用の簡易判定） */
function blockedBetween(allNodes, s, t, exitSide) {
  const gap = 12;
  const yLo = Math.min(s.y, t.y);
  const yHi = Math.max(s.y + s.height, t.y + t.height);
  for (const n of allNodes) {
    if (n === s || n === t) continue;
    if (n.y >= yHi || n.y + n.height <= yLo) continue;
    if (exitSide === "right") {
      // s の右外側から t の左辺に向かう水平廊下を横切るカード
      if (n.x > s.x + s.width + gap && n.x < t.x - gap) return true;
    } else {
      // s の左外側から t の右辺に向かう水平廊下を横切るカード
      if (n.x + n.width < s.x - gap && n.x + n.width > t.x + t.width + gap) return true;
    }
  }
  return false;
}

/** 直線配線がカードを横切りそうなエッジに、行間廊下を走る回避ウェイポイントを与える */
function addDetourWaypoints(allNodes, relations) {
  for (const rel of relations) {
    if (!rel.exitSide || rel.exitSide === rel.entrySide) continue;
    if (rel.exitSide !== "left" && rel.exitSide !== "right") continue;
    const s = allNodes.find((n) => n.id === rel.from);
    const t = allNodes.find((n) => n.id === rel.to);
    if (!s || !t) continue;
    if (!blockedBetween(allNodes, s, t, rel.exitSide)) continue;
    // 行間（上下カードの間の空白帯）を横切る廊下を通る
    let corridor = null;
    if (t.y + t.height < s.y) corridor = (t.y + t.height + s.y) / 2;
    else if (s.y + s.height < t.y) corridor = (s.y + s.height + t.y) / 2;
    if (corridor === null) continue;
    const xA = rel.exitSide === "right" ? s.x + s.width + 30 : s.x - 30;
    const xB = rel.exitSide === "right" ? t.x - 30 : t.x + t.width + 30;
    rel.waypoints = [
      { x: xA, y: corridor },
      { x: xB, y: corridor },
    ];
  }
}

function portStyle(side, frac) {
  switch (side) {
    case "top":
      return `exitX=${frac};exitY=0;exitDx=0;exitDy=0;`;
    case "bottom":
      return `exitX=${frac};exitY=1;exitDx=0;exitDy=0;`;
    case "left":
      return `exitX=0;exitY=${frac};exitDx=0;exitDy=0;`;
    default:
      return `exitX=1;exitY=${frac};exitDx=0;exitDy=0;`;
  }
}

function entryStyle(side, frac) {
  switch (side) {
    case "top":
      return `entryX=${frac};entryY=0;entryDx=0;entryDy=0;`;
    case "bottom":
      return `entryX=${frac};entryY=1;entryDx=0;entryDy=0;`;
    case "left":
      return `entryX=0;entryY=${frac};entryDx=0;entryDy=0;`;
    default:
      return `entryX=1;entryY=${frac};entryDx=0;entryDy=0;`;
  }
}

// ---------------------------------------------------------------------------
// セル XML 生成
// ---------------------------------------------------------------------------

const HEADER_TOP = 24; // ヘッダー帯の上端
const HEADER_GAP = 36;
const MARGIN = 40;
const LEGEND_W = 236;
const LEGEND_BAND_GAP = 60; // コンテンツ右端と凡例の間隔

function nodeCell(n, ids) {
  const pal = paletteFor(n.stereo);
  const nameHtml = pal.italic ? `<i>${esc(n.name)}</i>` : esc(n.name);
  const stereoHtml =
    n.stereo !== "default"
      ? `<div style="font-size:10px;font-weight:normal;color:#475569;">«${esc(n.stereo)}»</div>`
      : "";
  const value = `${stereoHtml}${nameHtml}`;

  const lines = [];
  const sw = `swimlane;html=1;whiteSpace=wrap;rounded=1;arcSize=6;startSize=${n.headerH};` +
    `fillColor=${pal.headerFill};swimlaneFillColor=#FFFFFF;strokeColor=${pal.stroke};` +
    `fontStyle=1;fontSize=13;fontColor=${TITLE_COLOR};align=center;verticalAlign=middle;` +
    `strokeWidth=1.5;`;
  const id = n._cellId;
  lines.push(
    `<mxCell id="${id}" value="${esc(value)}" style="${sw}" vertex="1" parent="1">` +
      `<mxGeometry x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" as="geometry"/>` +
      `</mxCell>`
  );

  const memberStyle =
    `text;html=1;whiteSpace=wrap;strokeColor=none;fillColor=none;align=left;verticalAlign=top;` +
    `spacingLeft=12;spacingTop=4;fontSize=11;fontColor=${MEMBER_COLOR};`;
  let cy = n.headerH;
  if (n.attributes.length > 0) {
    lines.push(
      `<mxCell id="${ids.child(id, "attrs")}" value="${n.attributes.map(escMember).join("&#10;")}" style="${memberStyle}" vertex="1" parent="${id}">` +
        `<mxGeometry x="1" y="${cy}" width="${n.width - 2}" height="${n.attrH}" as="geometry"/>` +
        `</mxCell>`
    );
    cy += n.attrH;
  }
  if (n.attrH > 0 && n.methH > 0) {
    lines.push(
      `<mxCell id="${ids.child(id, "sep")}" value="" style="rounded=0;html=1;fillColor=${SECTION_DIVIDER};strokeColor=none;" vertex="1" parent="${id}">` +
        `<mxGeometry x="0" y="${cy}" width="${n.width}" height="1" as="geometry"/>` +
        `</mxCell>`
    );
    cy += 1;
  }
  if (n.methods.length > 0) {
    lines.push(
      `<mxCell id="${ids.child(id, "methods")}" value="${n.methods.map(escMember).join("&#10;")}" style="${memberStyle}" vertex="1" parent="${id}">` +
        `<mxGeometry x="1" y="${cy}" width="${n.width - 2}" height="${n.methH}" as="geometry"/>` +
        `</mxCell>`
    );
  }
  return lines.join("\n");
}

function packageCells(pkg, ids) {
  const id = pkg._cellId;
  const boxStyle =
    `rounded=0;html=1;whiteSpace=wrap;dashed=1;dashPattern=6 4;` +
    `strokeColor=${PACKAGE_STROKE};strokeWidth=1;fillColor=${PACKAGE_FILL};`;
  const tabStyle =
    `text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;` +
    `fontSize=10;fontStyle=2;fontColor=${SUBTITLE_COLOR};`;
  return [
    `<mxCell id="${id}" value="" style="${boxStyle}" vertex="1" parent="1">` +
      `<mxGeometry x="${pkg.x}" y="${pkg.y}" width="${pkg.width}" height="${pkg.height}" as="geometry"/>` +
      `</mxCell>`,
    `<mxCell id="${ids.child(id, "tab")}" value="«package» ${esc(pkg.label)}" style="${tabStyle}" vertex="1" parent="1">` +
      `<mxGeometry x="${pkg.x + 12}" y="${pkg.y + 10}" width="${Math.min(pkg.width - 24, 300)}" height="20" as="geometry"/>` +
      `</mxCell>`,
  ].join("\n");
}

function relationCells(rel, idPrefix, ids) {
  const id = ids.id(idPrefix, String(rel._i));
  const type = rel._type;
  const style =
    `edgeStyle=orthogonalEdgeStyle;rounded=1;jettySize=auto;html=1;` +
    `${RELATION_STYLE[type]}` +
    `strokeColor=${RELATION_STROKE[type]};strokeWidth=1.5;` +
    `fontSize=11;fontColor=${MEMBER_COLOR};labelBackgroundColor=#FFFFFF;` +
    `${portStyle(rel.exitSide, rel.exitFrac)}${entryStyle(rel.entrySide, rel.entryFrac)}`;

  const geo = rel.waypoints
    ? `<mxGeometry relative="1" as="geometry"><Array as="points">` +
      rel.waypoints.map((p) => `<mxPoint x="${Math.round(p.x)}" y="${Math.round(p.y)}"/>`).join("") +
      `</Array></mxGeometry>`
    : `<mxGeometry relative="1" as="geometry"/>`;
  const lines = [
    `<mxCell id="${id}" value="${esc(rel.label || "")}" style="${style}" edge="1" parent="1" ` +
      `source="${ids.id("cls", rel.from)}" target="${ids.id("cls", rel.to)}">` +
      `${geo}` +
      `</mxCell>`,
  ];

  const labelStyle =
    `edgeLabel;html=1;fontSize=10;fontColor=${SUBTITLE_COLOR};labelBackgroundColor=#FFFFFF;`;
  if (rel.sourceMultiplicity) {
    lines.push(
      `<mxCell id="${ids.id(idPrefix, `${rel._i}-sm`)}" value="${esc(rel.sourceMultiplicity)}" style="${labelStyle}" vertex="1" connectable="0" parent="${id}">` +
        `<mxGeometry x="-0.72" relative="1" as="geometry"><mxPoint as="offset"/></mxGeometry>` +
        `</mxCell>`
    );
  }
  if (rel.targetMultiplicity) {
    lines.push(
      `<mxCell id="${ids.id(idPrefix, `${rel._i}-tm`)}" value="${esc(rel.targetMultiplicity)}" style="${labelStyle}" vertex="1" connectable="0" parent="${id}">` +
        `<mxGeometry x="0.7" relative="1" as="geometry"><mxPoint as="offset"/></mxGeometry>` +
        `</mxCell>`
    );
  }
  return lines.join("\n");
}

function legendCells(legendX, legendY, fx) {
  const W = 236;
  const ROW_H = 22;
  const rows = [
    { label: "Extends / Implements", style: "endArrow=block;endFill=0;endSize=10;strokeColor=#1E293B;" },
    {
      label: "Composition",
      style: "startArrow=diamondThin;startFill=1;startSize=10;endArrow=open;endSize=8;strokeColor=#1E293B;",
    },
    {
      label: "Aggregation",
      style: "startArrow=diamondThin;startFill=0;startSize=10;endArrow=open;endSize=8;strokeColor=#475569;",
    },
    {
      label: "Association / Dependency",
      style: "dashed=1;dashPattern=5 3;endArrow=open;endSize=8;strokeColor=#64748B;",
    },
  ];
  const H = 26 + rows.length * ROW_H + 8;
  const lines = [];
  lines.push(
    `<mxCell id="${fx("legend-box")}" value="" style="rounded=1;arcSize=8;html=1;whiteSpace=wrap;fillColor=#FFFFFF;strokeColor=${DIVIDER_COLOR};strokeWidth=1;" vertex="1" parent="1">` +
      `<mxGeometry x="${legendX}" y="${legendY}" width="${W}" height="${H}" as="geometry"/>` +
      `</mxCell>`
  );
  lines.push(
    `<mxCell id="${fx("legend-title")}" value="LEGEND" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=9;fontStyle=1;fontColor=${SUBTITLE_COLOR};spacingLeft=12;" vertex="1" parent="1">` +
      `<mxGeometry x="${legendX + 4}" y="${legendY + 4}" width="${W - 8}" height="18" as="geometry"/>` +
      `</mxCell>`
  );
  rows.forEach((r, i) => {
    const y = legendY + 26 + i * ROW_H + ROW_H / 2;
    lines.push(
      `<mxCell id="${fx(`legend-e${i}`)}" style="html=1;rounded=0;strokeWidth=1.5;${r.style}" edge="1" parent="1">` +
        `<mxGeometry relative="1" as="geometry">` +
        `<mxPoint x="${legendX + 14}" y="${y}" as="sourcePoint"/>` +
        `<mxPoint x="${legendX + 60}" y="${y}" as="targetPoint"/>` +
        `</mxGeometry>` +
        `</mxCell>`
    );
    lines.push(
      `<mxCell id="${fx(`legend-t${i}`)}" value="${esc(r.label)}" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=10;fontColor=${MEMBER_COLOR};" vertex="1" parent="1">` +
        `<mxGeometry x="${legendX + 68}" y="${y - 9}" width="${W - 76}" height="18" as="geometry"/>` +
        `</mxCell>`
    );
  });
  return { cells: lines.join("\n"), width: W, height: H };
}

// ---------------------------------------------------------------------------
// メイン: spec → .drawio XML
// ---------------------------------------------------------------------------

/**
 * spec オブジェクトから描画済み `.drawio` XML 文字列を生成する。
 * @param {object} spec JSON spec (references/spec-schema.md 参照)
 * @param {{title?: string, subtitle?: string, name?: string}} [opts]
 * @returns {string} mxfile XML
 */
export function buildDiagramXml(spec, opts = {}) {
  if (!spec || !Array.isArray(spec.classes) || spec.classes.length === 0) {
    throw new Error("spec.classes は 1 件以上の配列である必要があります");
  }

  const title = opts.title || spec.title || "Class Diagram";
  const subtitle = opts.subtitle ?? spec.subtitle ?? "";

  // --- ノード計測と配置（コンテンツ原点是 MARGIN, HEADER_TOP+HEADER_GAP+MARGIN）
  const nodes = spec.classes.map(measureNode);
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  if (nodesById.size !== nodes.length) {
    throw new Error("classes[].id (または name) が重複しています");
  }
  const grid = layoutGrid(nodes);

  const contentTop = HEADER_TOP + HEADER_GAP + 54; // 区切り線の下 + パッケージ上部余白
  for (const n of nodes) {
    n.x += MARGIN + 30;
    n.y += contentTop;
  }
  const contentLeft = MARGIN + 30;
  const contentRight = contentLeft + grid.width;
  const contentBottom = contentTop + grid.height;

  // --- パッケージ bbox
  const pkgDefs = new Map();
  for (const p of spec.packages || []) {
    pkgDefs.set(p.id, { id: p.id, label: p.label || p.id });
  }
  for (const n of nodes) {
    if (n.package && !pkgDefs.has(n.package)) {
      pkgDefs.set(n.package, { id: n.package, label: n.package });
    }
  }
  const packages = [];
  for (const p of pkgDefs.values()) {
    const members = nodes.filter((n) => n.package === p.id);
    if (members.length === 0) continue;
    const padX = 26;
    const padTop = 48;
    const padBottom = 26;
    const minX = Math.min(...members.map((m) => m.x));
    const minY = Math.min(...members.map((m) => m.y));
    const maxX = Math.max(...members.map((m) => m.x + m.width));
    const maxY = Math.max(...members.map((m) => m.y + m.height));
    packages.push({
      ...p,
      x: minX - padX,
      y: minY - padTop,
      width: maxX - minX + padX * 2,
      height: maxY - minY + padTop + padBottom,
    });
  }

  // --- リレーション
  const relations = [];
  let idx = 0;
  for (const r of spec.relations || []) {
    if (!nodesById.has(r.from) || !nodesById.has(r.to)) {
      console.warn(`[warn] relations の参照先が見つからないためスキップ: ${r.from} -> ${r.to}`);
      continue;
    }
    if (r.from === r.to) {
      console.warn(`[warn] 自己参照リレーションは未対応のためスキップ: ${r.from}`);
      continue;
    }
    relations.push({ ...r, _type: normalizeRelationType(r.type), _i: idx++ });
  }
  assignPorts(nodesById, relations);
  addDetourWaypoints(nodes, relations);

  // 元 ID → 内部セル ID の対応表（クラス・パッケージ・エッジ両端で共有）
  const ids = createCellIdMap();
  // 固定セル（ヘッダー・凡例）を先に採番して予約する。クラスノード・パッケージ・
  // エッジ・子セルも同じアロケーターを通すため、元 ID が正規形で衝突しても
  // mxCell ID の重複は起きない。子セル ID は `~` 区切り（sanitizeIdPart() が
  // 生成しない文字）なので固定セルと構造的に衝突しえない。
  const fx = (name) => ids.fixed(name);
  for (let i = 0; i < 8; i += 1) fx(`legend-e${i}`);
  for (let i = 0; i < 8; i += 1) fx(`legend-t${i}`);
  for (const n of nodes) n._cellId = ids.id("cls", n.id);

  // --- キャンバス幅: 右端に凡例専用の帯を確保し、パッケージと重ならないようにする
  const maxPkgRight = packages.length ? Math.max(...packages.map((p) => p.x + p.width)) : contentRight;
  const contentW = Math.max(contentRight, maxPkgRight);
  const canvasW = Math.max(contentW + LEGEND_BAND_GAP + LEGEND_W + MARGIN, 760);
  const canvasH =
    Math.max(contentBottom, ...(packages.length ? packages.map((p) => p.y + p.height) : [0])) +
    MARGIN;

  const dividerRight = canvasW - MARGIN;
  const legendX = Math.max(contentW + LEGEND_BAND_GAP, canvasW - MARGIN - LEGEND_W);
  const legendY = HEADER_TOP + HEADER_GAP + 36;

  // --- ヘッダー
  const cells = [];
  cells.push(
    `<mxCell id="${fx("accent")}" value="" style="rounded=0;html=1;fillColor=${ACCENT};strokeColor=none;" vertex="1" parent="1">` +
      `<mxGeometry x="${MARGIN}" y="${HEADER_TOP + 6}" width="6" height="44" as="geometry"/>` +
      `</mxCell>`
  );
  cells.push(
    `<mxCell id="${fx("title")}" value="${esc(title)}" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=18;fontStyle=1;fontColor=${TITLE_COLOR};spacingLeft=12;" vertex="1" parent="1">` +
      `<mxGeometry x="${MARGIN + 6}" y="${HEADER_TOP}" width="620" height="30" as="geometry"/>` +
      `</mxCell>`
  );
  if (subtitle) {
    cells.push(
      `<mxCell id="${fx("subtitle")}" value="${esc(subtitle)}" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=11;fontColor=${SUBTITLE_COLOR};spacingLeft=13;" vertex="1" parent="1">` +
        `<mxGeometry x="${MARGIN + 6}" y="${HEADER_TOP + 30}" width="620" height="18" as="geometry"/>` +
        `</mxCell>`
    );
  }
  cells.push(
    `<mxCell id="${fx("header-divider")}" value="" style="rounded=0;html=1;fillColor=${DIVIDER_COLOR};strokeColor=none;" vertex="1" parent="1">` +
      `<mxGeometry x="${MARGIN}" y="${HEADER_TOP + HEADER_GAP + 14}" width="${dividerRight - MARGIN}" height="2" as="geometry"/>` +
      `</mxCell>`
  );

  // --- 凡例
  cells.push(legendCells(legendX, legendY, fx).cells);

  // --- パッケージ（背景レイヤー）→ ノード → エッジ
  for (const p of packages) {
    p._cellId = ids.id("pkg", p.id);
    cells.push(packageCells(p, ids));
  }
  for (const n of nodes) cells.push(nodeCell(n, ids));
  for (const rel of relations) cells.push(relationCells(rel, "rel", ids));

  const diagramName = opts.name || title || "Class Diagram";
  return [
    `<mxfile host="drawio-class-skill" agent="drawio-class-skill" version="1.0.0" type="device">`,
    `  <diagram name="${esc(diagramName)}" id="class-diagram">`,
    `    <mxGraphModel dx="1200" dy="900" grid="0" gridSize="10" guides="1" tooltips="0" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="${Math.round(canvasW)}" pageHeight="${Math.round(canvasH)}" math="0" shadow="0">`,
    `      <root>`,
    `        <mxCell id="0"/>`,
    `        <mxCell id="1" parent="0"/>`,
    cells.map((c) => `        ${c}`).join("\n"),
    `      </root>`,
    `    </mxGraphModel>`,
    `  </diagram>`,
    `</mxfile>`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function loadSpec(values) {
  if (values.spec) {
    const raw = await fsp.readFile(values.spec, "utf8");
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`spec JSON の解析に失敗しました (${values.spec}): ${err.message}`);
    }
  }
  if (values["src-dir"]) {
    return scanDirectory(values["src-dir"], {
      title: values.title || `Class diagram (${values["src-dir"]})`,
    });
  }
  throw new Error("--spec または --src-dir のいずれかを指定してください");
}

export async function run(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      spec: { type: "string" },
      "src-dir": { type: "string" },
      output: { type: "string", short: "o" },
      "xml-out": { type: "string" },
      name: { type: "string" },
      title: { type: "string" },
      subtitle: { type: "string" },
      scale: { type: "string" },
      "no-png": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(HELP_TEXT);
    return;
  }

  // --- 入力・出力の衝突検査（必ず「最初の書き込み」より前に行う） -----------
  // --src-dir のソースファイル自体を --xml-out / --output に指定すると、
  // 読み取りが終わる前に上書きしてしまう。1 バイトも書き込む前に止める。
  const output = values.output || "class-diagram.drawio.png";
  const isSvg = /\.svg$/i.test(output);
  const xmlOut =
    values["xml-out"] ||
    output.replace(/(\.drawio)?\.(png|svg)$/i, "") + ".drawio";
  const sourceFiles = values.spec
    ? []
    : (
        await expandInputPaths(
          values["src-dir"] ? [values["src-dir"]] : [],
          /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i
        )
      ).files;

  assertOutputsDistinctFromInputs({
    inputs: values.spec
      ? [{ role: "--spec", value: values.spec }]
      : [{ role: "--src-dir", value: values["src-dir"], files: sourceFiles }],
    outputs: [
      { role: "--xml-out", value: xmlOut },
      { role: "--output", value: output },
    ],
  });

  const spec = await loadSpec(values);
  const xml = buildDiagramXml(spec, {
    title: values.title,
    subtitle: values.subtitle,
    name: values.name,
  });

  if (values["no-png"]) {
    await fsp.mkdir(path.dirname(path.resolve(xmlOut)), { recursive: true });
    await fsp.writeFile(xmlOut, xml, "utf8");
    console.log(`${output} の元 XML -> ${xmlOut}`);
    return;
  }

  const scale = values.scale ? Number(values.scale) : isSvg ? 1 : 2;
  // 先にメモリ上で変換し、成功してから .drawio / 画像を書き出す
  const { res } = await emitDiagramFiles({
    xml,
    outPath: output,
    xmlOutPath: xmlOut,
    convertPng: convertXmlToPng,
    convertSvg: convertXmlToSvg,
    scale,
    border: 14,
    theme: values.theme,
  });
  console.log(`${output} の元 XML -> ${xmlOut}`);
  console.log(`${xmlOut} -> ${output} (${res.width}x${res.height}px)`);
}

if (isDirectRun(import.meta.url)) {
  run().catch((err) => {
    console.error("Error:", err.message || err);
    process.exit(1);
  });
}
