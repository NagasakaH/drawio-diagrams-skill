#!/usr/bin/env node
/**
 * build-c4.mjs — C4 モデル（Container レベル）構成図生成 CLI (Pure Node.js / ゼロ依存)
 *
 * JSON spec (--spec) から、システム境界・人・コンテナ・DB・キュー・外部システムを
 * 描いた `.drawio` XML を生成し、同梱の `drawio2png.mjs` で
 * `.drawio.png`（XML 埋め込み済み）または `.svg` に変換する。
 *
 * 使用例:
 *   node scripts/build-c4.mjs --spec examples/c4/ecommerce-container.json \
 *     --output examples/output/ecommerce-c4-container.drawio.png
 *
 * spec の詳細は references/c4.md を参照。
 */

import fsSync from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { convertXmlToPng, convertXmlToSvg } from "./drawio2png.mjs";
import {
  assertDistinctPaths,
  createCellIdMap,
  emitDiagramFiles,
  isDirectRun,
} from "./diagram-shared.mjs";

// ---------------------------------------------------------------------------
// テーマパレット（C4 標準色をモダンに整えた系色）
// ---------------------------------------------------------------------------

const ACCENT = "#1D4ED8"; // 左アクセントバー
const TITLE_COLOR = "#0F172A";
const SUBTITLE_COLOR = "#475569";
const DIVIDER_COLOR = "#E2E8F0";
const BODY_COLOR = "#334155";

const BOUNDARY_FILL = "#F8FAFC";
const BOUNDARY_STROKE = "#94A3B8";

/** element.kind ごとの描画仕様 */
const KIND_STYLE = {
  person: {
    badge: "Person",
    fill: "#08427B",
    stroke: "#06315C",
    title: "#FFFFFF",
    sub: "#BFD7F2",
    w: 176,
    h: 92,
    shape: "card",
  },
  container: {
    badge: "Container",
    fill: "#1168BD",
    stroke: "#0B4E93",
    title: "#FFFFFF",
    sub: "#CFE4FA",
    w: 232,
    h: 104,
    shape: "card",
  },
  database: {
    badge: "Database",
    fill: "#0E4C8A",
    stroke: "#093A6B",
    title: "#FFFFFF",
    sub: "#C7DBF3",
    w: 208,
    h: 116,
    shape: "cylinder",
  },
  queue: {
    badge: "Queue / Stream",
    fill: "#0E7490",
    stroke: "#155E75",
    title: "#FFFFFF",
    sub: "#C6F0FA",
    w: 228,
    h: 104,
    shape: "card",
  },
  external: {
    badge: "External System",
    fill: "#F1F5F9",
    stroke: "#64748B",
    title: "#1E293B",
    sub: "#64748B",
    w: 212,
    h: 96,
    shape: "card",
  },
};

const REL_STYLE = {
  sync: "endArrow=block;endFill=1;strokeColor=#1D4ED8;",
  async: "endArrow=open;endFill=0;dashed=1;dashPattern=6 3;strokeColor=#0E7490;",
  external: "endArrow=block;endFill=1;strokeColor=#64748B;",
};
const REL_LABEL_COLOR = {
  sync: "#1E3A8A",
  async: "#155E75",
  external: "#475569",
};

// ---------------------------------------------------------------------------
// 配置・採寸の定数
// ---------------------------------------------------------------------------

const MARGIN = 40;
const HEADER_TOP = 24;
const HEADER_GAP = 36;
const CONTENT_PAD_TOP = 66;
const CONTENT_PAD_LEFT = 40;
const H_GAP = 150;
const V_GAP = 116;
const LEGEND_W = 250;
const LEGEND_BAND_GAP = 64;

const TITLE_FONT = 13;
const SUB_FONT = 10;
const DESC_FONT = 10;
const LABEL_FONT = 10.5;
const LABEL_LINE_H = 15;
const LABEL_MAX_W = 132;
const TEXT_PAD = 22;
const LINE_H = 15;

const HELP_TEXT = `
build-c4.mjs - C4 container diagram generator (.drawio + .drawio.png / .svg), zero dependency

Usage:
  node build-c4.mjs --spec <spec.json> [options]

Options:
  --spec <path>         JSON spec file (see references/c4.md)
  -o, --output <path>   Output file: *.drawio.png (default) or *.svg
      --xml-out <path>  Where to write the intermediate .drawio XML
                        (default: <output> without .png/.svg suffix)
      --name <name>     Diagram (page) name (default: spec title or "C4 Container Diagram")
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

const FULLWIDTH_RE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function charWidth(ch, fontSize, isBold) {
  if (ch === " " || ch === "\u00a0") return fontSize * 0.31;
  if (FULLWIDTH_RE.test(ch)) return fontSize * (isBold ? 1.04 : 1.0);
  if ("ilI1|.,:;!'`()[]{}".includes(ch)) return fontSize * (isBold ? 0.36 : 0.32);
  if ("mwMW@%".includes(ch)) return fontSize * (isBold ? 0.88 : 0.82);
  if (ch >= "A" && ch <= "Z") return fontSize * (isBold ? 0.67 : 0.63);
  return fontSize * (isBold ? 0.56 : 0.52);
}

function textWidth(text, fontSize, isBold = false) {
  let total = 0;
  for (const ch of String(text || "")) total += charWidth(ch, fontSize, isBold);
  return total;
}

function tokenize(text) {
  return (
    String(text || "").match(
      /[\u2E80-\u30FF\u3400-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF]|[A-Za-z0-9_./:;#=()+%&!?'[\]-]+|\s+/g
    ) || []
  );
}

function wrapLabelLines(text, fontSize, maxWidth) {
  const out = [];
  let line = "";
  for (const tok of tokenize(text)) {
    const next = line + tok;
    if (line && textWidth(next, fontSize, false) > maxWidth) {
      out.push(line.trimEnd());
      line = tok.trimStart();
    } else {
      line = next;
    }
  }
  if (line.trim()) out.push(line.trimEnd());
  return out.length ? out : [""];
}

// 元 ID → 一意な内部セル ID の対応表（生成関数の中で createCellIdMap() で作る）。
// `注文` / `顧客` のような非 ASCII ID や `a.b` / `a/b` の記号違いが
// 同じ正規形に潰れて衝突しないよう、重複時は連番を付けて区別する。

function normalizeKind(kind) {
  const key = String(kind || "container").trim().toLowerCase();
  if (key === "person" || key === "actor" || key === "user") return "person";
  if (key === "database" || key === "db") return "database";
  if (key === "queue" || key === "stream" || key === "topic" || key === "bus") return "queue";
  if (key === "external" || key === "system" || key === "external-system" || key === "third-party")
    return "external";
  return "container";
}

function normalizeRelKind(kind) {
  const key = String(kind || "sync").trim().toLowerCase();
  if (key === "async" || key === "event" || key === "publish" || key === "subscribe") return "async";
  if (key === "external" || key === "third" || key === "outbound") return "external";
  return "sync";
}

// ---------------------------------------------------------------------------
// 要素の採寸とレイアウト
// ---------------------------------------------------------------------------

function measureElement(raw) {
  const kind = normalizeKind(raw.kind);
  const style = KIND_STYLE[kind];
  const name = raw.name || raw.id;
  const tech = raw.tech ? (raw.techLabel ?? `[${style.badge}]  ${raw.tech}`) : `[${style.badge}]`;
  const desc = raw.description || raw.desc || "";

  const innerW = style.w - TEXT_PAD * 2;
  const titleLines = wrapLabelLines(name, TITLE_FONT, innerW);
  const subLines = wrapLabelLines(tech, SUB_FONT, innerW);
  const descLines = desc ? wrapLabelLines(desc, DESC_FONT, innerW) : [];
  const lines = titleLines.length + subLines.length + descLines.length;

  const height =
    style.h +
    Math.max(0, lines - 2) * LINE_H +
    (kind === "database" ? 16 : 0);

  return {
    ...raw,
    id: raw.id || name,
    kind,
    name,
    tech,
    desc,
    titleLines,
    subLines,
    descLines,
    width: style.w,
    height,
    x: 0,
    y: 0,
  };
}

function layoutGrid(nodes, warnings = []) {
  const explicitRows = nodes.filter((n) => Number.isInteger(n.row)).map((n) => n.row);
  const firstAutoRow = explicitRows.length ? Math.max(...explicitRows) + 1 : 0;
  let autoRow = firstAutoRow;
  for (const n of nodes) {
    if (!Number.isInteger(n.row)) {
      n.row = autoRow;
      autoRow += 1;
    }
  }
  const byRow = new Map();
  for (const n of nodes) {
    if (!byRow.has(n.row)) byRow.set(n.row, []);
    byRow.get(n.row).push(n);
  }
  for (const [rowNo, rowNodes] of byRow) {
    const used = new Set();
    let next = 0;
    for (const n of rowNodes) {
      if (Number.isInteger(n.col)) {
        if (used.has(n.col)) {
          // 同じ (row, col) を 2 つ以上の要素が明示指定したら、後の要素を
          // すぐ右の空き列へ寄せて重ならないようにし、警告を残す。
          let free = n.col + 1;
          while (used.has(free)) free += 1;
          warnings.push(
            `配置衝突: 要素 ${n.id} の指定 (row=${rowNo}, col=${n.col}) は` +
              `先着要素と重複するため col=${free} へずらしました。`
          );
          n._col = free;
          used.add(free);
        } else {
          n._col = n.col;
          used.add(n.col);
        }
      } else {
        while (used.has(next)) next += 1;
        n._col = next;
        used.add(next);
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
    n._rowBand = { top: rowY.get(n.row), bottom: rowY.get(n.row) + rowH.get(n.row) };
  }
  return { width: x > 0 ? x - H_GAP : 0, height: y > 0 ? y - V_GAP : 0 };
}

// ---------------------------------------------------------------------------
// 関係線の配線計画
// ---------------------------------------------------------------------------

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

function planRelations(nodes, relations) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kept = [];
  for (const rel of relations) {
    const s = byId.get(rel.from);
    const t = byId.get(rel.to);
    if (!s || !t) {
      console.warn(`[warn] relationships の参照先が無いためスキップ: ${rel.from} -> ${rel.to}`);
      continue;
    }
    kept.push({ ...rel, _s: s, _t: t });
  }

  const sideCount = new Map();
  for (const rel of kept) {
    const s = rel._s;
    const t = rel._t;
    const dx = t.x + t.width / 2 - (s.x + s.width / 2);
    const dy = t.y + t.height / 2 - (s.y + s.height / 2);
    let exitSide;
    let entrySide;
    if (Math.abs(dy) >= Math.abs(dx) * 0.9 && Math.abs(dy) >= 40) {
      exitSide = dy > 0 ? "bottom" : "top";
      entrySide = dy > 0 ? "top" : "bottom";
    } else {
      exitSide = dx > 0 ? "right" : "left";
      entrySide = dx > 0 ? "left" : "right";
    }
    rel.exitSide = exitSide;
    rel.entrySide = entrySide;
    rel._exitKey = `${rel.from}|${exitSide}`;
    for (const [id, side] of [
      [rel.from, exitSide],
      [rel.to, entrySide],
    ]) {
      const key = `${id}|${side}`;
      sideCount.set(key, (sideCount.get(key) || 0) + 1);
    }
  }

  const fracUsed = new Map();
  for (const rel of kept) {
    const take = (id, side) => {
      const key = `${id}|${side}`;
      const count = sideCount.get(key) || 1;
      const idx = fracUsed.get(key) || 0;
      fracUsed.set(key, idx + 1);
      if (count === 1) return 0.5;
      return Number((0.28 + (0.44 * idx) / (count - 1)).toFixed(3));
    };
    rel.exitFrac = take(rel.from, rel.exitSide);
    rel.entryFrac = take(rel.to, rel.entrySide);
    rel._exitCount = sideCount.get(rel._exitKey) || 1;
    // 同じ側から出る複数本は、ラベルを沿線方向にずらして重ねない
    if (rel._exitCount > 1) {
      const idx = (fracUsed.get(rel._exitKey) || 1) - 1;
      rel._labelT = idx % 2 === 0 ? -0.35 : 0.35;
    }
  }

  // 逆向きペア（A→B と B→A）はラベルを左右に分ける
  const pairIdx = new Map();
  for (const rel of kept) {
    const key = [rel.from, rel.to].sort().join("|");
    const n = pairIdx.get(key) || 0;
    pairIdx.set(key, n + 1);
    rel._labelSide = n === 0 ? "pos" : "neg";
  }

  // 他要素を横切る水平直線は縦方向の廊下へ回避
  for (const rel of kept) {
    if (rel.exitSide !== "right" && rel.exitSide !== "left") continue;
    const s = rel._s;
    const t = rel._t;
    const lo = Math.min(s.y, t.y) - 6;
    const hi = Math.max(s.y + s.height, t.y + t.height) + 6;
    let blocked = false;
    for (const n of nodes) {
      if (n === s || n === t) continue;
      if (n.y >= hi || n.y + n.height <= lo) continue;
      if (rel.exitSide === "right" && n.x > s.x + s.width + 10 && n.x < t.x - 10) blocked = true;
      if (rel.exitSide === "left" && n.x + n.width < s.x - 10 && n.x + n.width > t.x + t.width + 10)
        blocked = true;
    }
    if (!blocked) continue;
    let corridor;
    if (t.y + t.height < s.y) corridor = (t.y + t.height + s.y) / 2;
    else if (s.y + s.height < t.y) corridor = (s.y + s.height + t.y) / 2;
    else corridor = s.y + s.height + 46;
    const xA = rel.exitSide === "right" ? s.x + s.width + 36 : s.x - 36;
    const xB = rel.exitSide === "right" ? t.x - 36 : t.x + t.width + 36;
    rel.waypoints = [
      { x: Math.round(xA), y: Math.round(corridor) },
      { x: Math.round(xB), y: Math.round(corridor) },
    ];
  }

  return kept;
}

// ---------------------------------------------------------------------------
// セル XML 生成
// ---------------------------------------------------------------------------

function elementCell(n) {
  const style = KIND_STYLE[n.kind];
  const id = n._cellId;
  const parts = [];
  for (const line of n.titleLines)
    parts.push(`<div style="font-size:${TITLE_FONT}px;font-weight:bold;">${esc(line)}</div>`);
  for (const line of n.subLines)
    parts.push(
      `<div style="font-size:${SUB_FONT}px;font-weight:normal;color:${style.sub};">${esc(line)}</div>`
    );
  if (n.descLines.length) {
    parts.push(
      `<div style="font-size:${DESC_FONT}px;font-weight:normal;color:${style.sub};">&nbsp;</div>`
    );
    for (const line of n.descLines)
      parts.push(
        `<div style="font-size:${DESC_FONT}px;font-weight:normal;color:${style.sub};">${esc(line)}</div>`
      );
  }
  const value = parts.join("");

  const base =
    `html=1;whiteSpace=wrap;shadow=0;align=center;verticalAlign=middle;` +
    `spacingLeft=10;spacingRight=10;fontSize=${TITLE_FONT};fontStyle=1;fontColor=${style.title};` +
    `fillColor=${style.fill};strokeColor=${style.stroke};strokeWidth=1.2;`;
  const shape =
    n.kind === "database"
      ? `shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=14;`
      : `rounded=1;arcSize=10;`;

  return (
    `<mxCell id="${id}" value="${esc(value)}" style="${shape}${base}" vertex="1" parent="1">` +
    `<mxGeometry x="${Math.round(n.x)}" y="${Math.round(n.y)}" width="${Math.round(n.width)}" height="${Math.round(n.height)}" as="geometry"/>` +
    `</mxCell>`
  );
}

function boundaryCell(b) {
  const id = b._cellId;
  const boxStyle =
    `rounded=1;arcSize=3;html=1;whiteSpace=wrap;dashed=1;dashPattern=8 4;` +
    `fillColor=${BOUNDARY_FILL};strokeColor=${BOUNDARY_STROKE};strokeWidth=1.2;verticalAlign=bottom;` +
    `align=left;spacingLeft=18;spacingBottom=12;fontSize=11;fontStyle=2;fontColor=#475569;`;
  const kindLabel = b.kind ? `[${b.kind}] ` : "";
  return (
    `<mxCell id="${id}" value="${esc(`${kindLabel}${b.label}`)}" style="${boxStyle}" vertex="1" parent="1">` +
    `<mxGeometry x="${Math.round(b.x)}" y="${Math.round(b.y)}" width="${Math.round(b.width)}" height="${Math.round(b.height)}" as="geometry"/>` +
    `</mxCell>`
  );
}

function relationCell(rel, index) {
  const kind = normalizeRelKind(rel.kind);
  const id = `rel-${index}`;
  const style =
    `edgeStyle=orthogonalEdgeStyle;rounded=1;jettySize=auto;html=1;` +
    `${REL_STYLE[kind]}strokeWidth=1.6;` +
    `${portStyle(rel.exitSide, rel.exitFrac ?? 0.5)}${entryStyle(rel.entrySide, rel.entryFrac ?? 0.5)}`;
  const geo = rel.waypoints
    ? `<mxGeometry relative="1" as="geometry"><Array as="points">` +
      rel.waypoints.map((p) => `<mxPoint x="${p.x}" y="${p.y}"/>`).join("") +
      `</Array></mxGeometry>`
    : `<mxGeometry relative="1" as="geometry"/>`;
  const labelId = rel._labelCellId;
  const cells = [
    `<mxCell id="${id}" value="" style="${style}" edge="1" parent="1" ` +
      `source="${rel._s._cellId}" target="${rel._t._cellId}">${geo}</mxCell>`,
  ];
  const label = rel.label || rel.description || "";
  if (String(label).trim()) {
    const lines = wrapLabelLines(label, LABEL_FONT, LABEL_MAX_W);
    const w = Math.ceil(Math.max(...lines.map((l) => textWidth(l, LABEL_FONT, false))) + 8);
    const h = lines.length * LABEL_LINE_H + 4;
    const vertical = rel.exitSide === "bottom" || rel.exitSide === "top";
    let labelT = 0;
    let sign;
    if (vertical) {
      sign = -1;
      if ((rel._exitCount || 1) > 1) sign = (rel.exitFrac ?? 0.5) < 0.5 ? -1 : 1;
      labelT = -0.5;
    } else {
      // 同一側から複数本出る場合は上／下へ分け、単線は線の上に置く
      sign =
        (rel._exitCount || 1) > 1
          ? (rel.exitFrac ?? 0.5) < 0.5
            ? -1
            : 1
          : rel._labelSide === "neg"
            ? 1
            : -1;
      labelT = rel._labelT ?? (rel.waypoints ? -0.45 : 0);
    }
    const ox = vertical ? sign * (w / 2 + 12) : 0;
    const oy = vertical ? 0 : sign * -(h / 2 + 8);
    const labelStyle =
      `edgeLabel;html=1;whiteSpace=wrap;align=center;verticalAlign=middle;` +
      `fontSize=${LABEL_FONT};fontColor=${REL_LABEL_COLOR[kind]};` +
      `labelBackgroundColor=#FFFFFF;labelBorderColor=none;`;
    cells.push(
      `<mxCell id="${labelId}" value="${lines.map(esc).join("&#10;")}" style="${labelStyle}" ` +
        `vertex="1" connectable="0" parent="${id}">` +
        `<mxGeometry x="${labelT}" relative="1" as="geometry">` +
        `<mxPoint as="offset" x="${Math.round(ox)}" y="${Math.round(oy)}"/>` +
        `</mxGeometry></mxCell>`
    );
  }
  return cells.join("\n");
}

function headerCells(title, subtitle, canvasW, fx) {
  const cells = [];
  cells.push(
    `<mxCell id="${fx("accent")}" value="" style="rounded=0;html=1;fillColor=${ACCENT};strokeColor=none;" vertex="1" parent="1">` +
      `<mxGeometry x="${MARGIN}" y="${HEADER_TOP + 6}" width="6" height="44" as="geometry"/></mxCell>`
  );
  cells.push(
    `<mxCell id="${fx("title")}" value="${esc(title)}" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=18;fontStyle=1;fontColor=${TITLE_COLOR};spacingLeft=12;" vertex="1" parent="1">` +
      `<mxGeometry x="${MARGIN + 6}" y="${HEADER_TOP}" width="760" height="30" as="geometry"/></mxCell>`
  );
  if (subtitle) {
    cells.push(
      `<mxCell id="${fx("subtitle")}" value="${esc(subtitle)}" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=11;fontColor=${SUBTITLE_COLOR};spacingLeft=13;" vertex="1" parent="1">` +
        `<mxGeometry x="${MARGIN + 6}" y="${HEADER_TOP + 30}" width="820" height="18" as="geometry"/></mxCell>`
    );
  }
  cells.push(
    `<mxCell id="${fx("header-divider")}" value="" style="rounded=0;html=1;fillColor=${DIVIDER_COLOR};strokeColor=none;" vertex="1" parent="1">` +
      `<mxGeometry x="${MARGIN}" y="${HEADER_TOP + HEADER_GAP + 14}" width="${canvasW - MARGIN * 2}" height="2" as="geometry"/></mxCell>`
  );
  return cells;
}

function legendCells(legendX, legendY, fx) {
  const rows = [
    { type: "swatch", label: "Person", fill: KIND_STYLE.person.fill, stroke: KIND_STYLE.person.stroke },
    {
      type: "swatch",
      label: "Container",
      fill: KIND_STYLE.container.fill,
      stroke: KIND_STYLE.container.stroke,
    },
    {
      type: "cylinder",
      label: "Database / Cache",
      fill: KIND_STYLE.database.fill,
      stroke: KIND_STYLE.database.stroke,
    },
    { type: "swatch", label: "Queue / Stream", fill: KIND_STYLE.queue.fill, stroke: KIND_STYLE.queue.stroke },
    {
      type: "swatch",
      label: "External System",
      fill: KIND_STYLE.external.fill,
      stroke: KIND_STYLE.external.stroke,
    },
    { type: "edge", label: "同期呼び出し (sync)", style: "endArrow=block;endFill=1;strokeColor=#1D4ED8;" },
    {
      type: "edge",
      label: "非同期イベント (async)",
      style: "endArrow=open;endFill=0;dashed=1;dashPattern=6 3;strokeColor=#0E7490;",
    },
    {
      type: "box",
      label: "System Boundary",
      fill: BOUNDARY_FILL,
      stroke: BOUNDARY_STROKE,
    },
  ];
  const ROW_H = 24;
  const H = 30 + rows.length * ROW_H + 10;
  const cells = [];
  cells.push(
    `<mxCell id="${fx("legend-box")}" value="" style="rounded=1;arcSize=8;html=1;whiteSpace=wrap;fillColor=#FFFFFF;strokeColor=${DIVIDER_COLOR};strokeWidth=1;" vertex="1" parent="1">` +
      `<mxGeometry x="${legendX}" y="${legendY}" width="${LEGEND_W}" height="${H}" as="geometry"/></mxCell>`
  );
  cells.push(
    `<mxCell id="${fx("legend-title")}" value="LEGEND" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=9;fontStyle=1;fontColor=${SUBTITLE_COLOR};spacingLeft=12;" vertex="1" parent="1">` +
      `<mxGeometry x="${legendX + 4}" y="${legendY + 6}" width="${LEGEND_W - 8}" height="18" as="geometry"/></mxCell>`
  );
  rows.forEach((r, i) => {
    const cy = legendY + 30 + i * ROW_H + ROW_H / 2;
    if (r.type === "edge") {
      cells.push(
        `<mxCell id="${fx(`legend-e${i}`)}" style="html=1;rounded=0;strokeWidth=1.6;${r.style}" edge="1" parent="1">` +
          `<mxGeometry relative="1" as="geometry"><mxPoint x="${legendX + 14}" y="${cy}" as="sourcePoint"/>` +
          `<mxPoint x="${legendX + 62}" y="${cy}" as="targetPoint"/></mxGeometry></mxCell>`
      );
    } else if (r.type === "cylinder") {
      cells.push(
        `<mxCell id="${fx(`legend-e${i}`)}" value="" style="shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=5;html=1;fillColor=${r.fill};strokeColor=${r.stroke};" vertex="1" parent="1">` +
          `<mxGeometry x="${legendX + 22}" y="${cy - 11}" width="30" height="22" as="geometry"/></mxCell>`
      );
    } else if (r.type === "box") {
      cells.push(
        `<mxCell id="${fx(`legend-e${i}`)}" value="" style="rounded=1;arcSize=8;html=1;dashed=1;dashPattern=8 4;fillColor=${r.fill};strokeColor=${r.stroke};strokeWidth=1;" vertex="1" parent="1">` +
          `<mxGeometry x="${legendX + 14}" y="${cy - 9}" width="44" height="18" as="geometry"/></mxCell>`
      );
    } else {
      cells.push(
        `<mxCell id="${fx(`legend-e${i}`)}" value="" style="rounded=1;arcSize=16;html=1;fillColor=${r.fill};strokeColor=${r.stroke};" vertex="1" parent="1">` +
          `<mxGeometry x="${legendX + 18}" y="${cy - 8}" width="36" height="16" as="geometry"/></mxCell>`
      );
    }
    cells.push(
      `<mxCell id="${fx(`legend-t${i}`)}" value="${esc(r.label)}" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=10;fontColor=${BODY_COLOR};spacingLeft=6;" vertex="1" parent="1">` +
        `<mxGeometry x="${legendX + 68}" y="${cy - 9}" width="${LEGEND_W - 76}" height="18" as="geometry"/></mxCell>`
    );
  });
  return { cells: cells.join("\n"), height: H };
}

// ---------------------------------------------------------------------------
// メイン: spec → .drawio XML
// ---------------------------------------------------------------------------

/**
 * spec オブジェクトから `.drawio` XML 文字列を生成する。
 * @param {object} spec JSON spec（references/c4.md 参照）
 * @param {{title?: string, subtitle?: string, name?: string}} [opts]
 * @returns {string} mxfile XML
 */
export function generateC4DiagramXml(spec, opts = {}) {
  if (!spec || !Array.isArray(spec.elements) || spec.elements.length === 0) {
    throw new Error("spec.elements は 1 件以上の配列である必要があります");
  }
  const title = opts.title || spec.title || "C4 Container Diagram";
  const subtitle = opts.subtitle ?? spec.subtitle ?? "";

  const nodes = spec.elements.map(measureElement);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) throw new Error("elements[].id が重複しています");

  const layoutWarnings = Array.isArray(opts.warnings) ? opts.warnings : [];
  const grid = layoutGrid(nodes, layoutWarnings);
  const contentLeft = MARGIN + CONTENT_PAD_LEFT;
  const contentTop = HEADER_TOP + HEADER_GAP + CONTENT_PAD_TOP;
  for (const n of nodes) {
    n.x += contentLeft;
    n.y += contentTop;
    if (n._rowBand) {
      n._rowBand = { top: n._rowBand.top + contentTop, bottom: n._rowBand.bottom + contentTop };
    }
  }

  // 境界枠（所属要素の外接矩形）
  const boundaryDefs = new Map();
  for (const b of spec.boundaries || []) boundaryDefs.set(b.id, { ...b });
  for (const n of nodes) {
    if (n.boundary && !boundaryDefs.has(n.boundary))
      boundaryDefs.set(n.boundary, { id: n.boundary, label: n.boundary });
  }
  const boundaries = [];
  for (const b of boundaryDefs.values()) {
    const members = nodes.filter((n) => n.boundary === b.id);
    if (!members.length) continue;
    const padX = 34;
    const padTop = 30;
    const padBottom = 52; // 左下にシステム名ラベルを置くための余白
    const minX = Math.min(...members.map((m) => m.x));
    const minY = Math.min(...members.map((m) => m.y));
    const maxX = Math.max(...members.map((m) => m.x + m.width));
    const maxY = Math.max(...members.map((m) => m.y + m.height));
    boundaries.push({
      ...b,
      label: b.label || b.id,
      x: minX - padX,
      y: minY - padTop,
      width: maxX - minX + padX * 2,
      height: maxY - minY + padTop + padBottom,
    });
  }

  const relations = planRelations(nodes, spec.relationships || []);

  // 元 ID → 内部セル ID の対応表を一度だけ作る（本体・子セル・エッジ両端で共有）
  const ids = createCellIdMap();
  // 固定セル（見出し・凡例）を先に予約し、要素・境界・エッジ・ラベルも
  // 同じアロケーターで採番するため mxCell ID の重複は起きない。
  const fx = (name) => ids.fixed(name);
  for (let i = 0; i < 10; i += 1) { fx(`legend-e${i}`); fx(`legend-t${i}`); }
  for (const n of nodes) n._cellId = ids.id("c4", n.id);
  for (const b of boundaries) b._cellId = ids.id("bd", b.id);
  relations.forEach((rel, i) => {
    ids.id("rel", String(i)); // エッジ本体 ID `rel-<i>` を予約
    rel._labelCellId = ids.id("rel", `${i}-lbl`); // ラベルセル `rel-<i>-lbl`
  });

  const contentRight = Math.max(
    contentLeft + grid.width,
    ...(boundaries.length ? boundaries.map((b) => b.x + b.width) : [0])
  );
  const contentBottom = Math.max(
    contentTop + grid.height,
    ...(boundaries.length ? boundaries.map((b) => b.y + b.height) : [0])
  );
  const canvasW = Math.max(contentRight + LEGEND_BAND_GAP + LEGEND_W + MARGIN, 860);
  const legendX = Math.max(contentRight + LEGEND_BAND_GAP, canvasW - MARGIN - LEGEND_W);
  const legendY = HEADER_TOP + HEADER_GAP + 34;
  const legendH = legendCells(legendX, legendY, fx).height;
  const canvasH = Math.max(contentBottom, legendY + legendH) + MARGIN;

  const cells = headerCells(title, subtitle, canvasW - MARGIN, fx);
  cells.push(legendCells(legendX, legendY, fx).cells);
  for (const b of boundaries) cells.push(boundaryCell(b));
  for (const n of nodes) cells.push(elementCell(n));
  relations.forEach((rel, i) => cells.push(relationCell(rel, i)));

  const diagramName = opts.name || title || "C4 Container Diagram";
  return [
    `<mxfile host="drawio-c4-skill" agent="drawio-c4-skill" version="1.0.0" type="device">`,
    `  <diagram name="${esc(diagramName)}" id="c4-container">`,
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

export async function run(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      spec: { type: "string" },
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
  if (!values.spec) throw new Error("--spec で JSON spec を指定してください");

  let spec;
  try {
    spec = JSON.parse(await fsp.readFile(values.spec, "utf8"));
  } catch (err) {
    throw new Error(`spec JSON の解析に失敗しました (${values.spec}): ${err.message}`);
  }

  const layoutWarnings = [];
  const xml = generateC4DiagramXml(spec, {
    title: values.title,
    subtitle: values.subtitle,
    name: values.name,
    warnings: layoutWarnings,
  });

  const output = values.output || "c4-container.drawio.png";
  const isSvg = /\.svg$/i.test(output);
  const xmlOut =
    values["xml-out"] || output.replace(/(\.drawio)?\.(png|svg)$/i, "") + ".drawio";

  // 入力 (--spec) と --xml-out / --output が正規化後に同一パスなら先行エラーで止める
  assertDistinctPaths([
    { role: "--spec", value: values.spec },
    { role: "--xml-out", value: xmlOut },
    { role: "--output", value: output },
  ]);

  if (values["no-png"]) {
    await fsp.mkdir(path.dirname(path.resolve(xmlOut)), { recursive: true });
    await fsp.writeFile(xmlOut, xml, "utf8");
    console.log(`${output} の元 XML -> ${xmlOut}`);
    for (const w of layoutWarnings) console.warn(`[warn] ${w}`);
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
  });
  console.log(`${output} の元 XML -> ${xmlOut}`);
  console.log(`${xmlOut} -> ${output} (${res.width}x${res.height}px)`);
  for (const w of layoutWarnings) console.warn(`[warn] ${w}`);
}

if (isDirectRun(import.meta.url)) {
  run().catch((err) => {
    console.error("Error:", err.message || err);
    process.exit(1);
  });
}
