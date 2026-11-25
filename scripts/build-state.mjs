#!/usr/bin/env node
/**
 * build-state.mjs — UML 状態遷移図生成 CLI (Pure Node.js / ゼロ依存)
 *
 * JSON spec (--spec) から、モダンな状態遷移図 `.drawio` XML を生成し、
 * 同梱の `drawio2png.mjs` で `.drawio.png`（XML 埋め込み済み）または `.svg` に変換する。
 *
 * 使用例:
 *   node scripts/build-state.mjs --spec examples/state/order-lifecycle.json \
 *     --output examples/output/order-lifecycle-state.drawio.png
 *
 * spec の詳細は references/state.md を参照。
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
  resolveWriteTarget,
  writeFileAtomic,
} from "./diagram-shared.mjs";

// ---------------------------------------------------------------------------
// テーマパレット
// ---------------------------------------------------------------------------

const ACCENT = "#7C3AED"; // 左アクセントバー（状態遷移図の系色）
const TITLE_COLOR = "#0F172A";
const SUBTITLE_COLOR = "#475569";
const DIVIDER_COLOR = "#E2E8F0";
const BODY_COLOR = "#334155";
const ACTION_COLOR = "#475569";
const DOT_COLOR = "#0F172A"; // 初期状態 / 終了状態の内側黒丸

/** semantic 状態カードの配色（fill / stroke / 見出し色） */
const PALETTE = {
  normal: { fill: "#EEF2FF", stroke: "#4F46E5", name: "#312E81" },
  active: { fill: "#DBEAFE", stroke: "#2563EB", name: "#1E3A8A" },
  success: { fill: "#ECFDF5", stroke: "#059669", name: "#065F46" },
  warning: { fill: "#FFFBEB", stroke: "#D97706", name: "#92400E" },
  error: { fill: "#FEF2F2", stroke: "#DC2626", name: "#991B1B" },
  neutral: { fill: "#F8FAFC", stroke: "#64748B", name: "#334155" },
};

/** 遷移矢印のスタイル（kind → 描画） */
const TRANSITION_STYLE = {
  normal: "endArrow=block;endFill=1;strokeColor=#475569;",
  success: "endArrow=block;endFill=1;strokeColor=#059669;",
  error: "endArrow=block;endFill=1;dashed=1;dashPattern=6 3;strokeColor=#DC2626;",
  cancel: "endArrow=block;endFill=1;dashed=1;dashPattern=6 3;strokeColor=#DC2626;",
  retry: "endArrow=block;endFill=1;dashed=1;dashPattern=4 3;strokeColor=#D97706;",
};
const TRANSITION_LABEL_COLOR = {
  normal: "#334155",
  success: "#065F46",
  error: "#B91C1C",
  cancel: "#B91C1C",
  retry: "#92400E",
};

const GROUP_FILL = "#FAF7FF";
const GROUP_STROKE = "#A78BFA";

// ---------------------------------------------------------------------------
// 配置・採寸の定数
// ---------------------------------------------------------------------------

const MARGIN = 40;
const HEADER_TOP = 24;
const HEADER_GAP = 36;
const CONTENT_PAD_TOP = 60;
const CONTENT_PAD_LEFT = 34;
const H_GAP = 176;
const V_GAP = 138;
const LEGEND_W = 250;
const LEGEND_BAND_GAP = 64;

const LINE_H = 16;
const MIN_STATE_W = 148;
const MAX_STATE_W = 300;
const NAME_FONT = 13;
const ACTION_FONT = 10.5;
const HEADER_H = 34; // 状態名エリアの高さ
const LABEL_FONT = 10.5;
const LABEL_LINE_H = 15;
const LABEL_MAX_W = 138;
const DOT_D = 22; // 初期状態の直径
const FINAL_D = 30; // 終了状態の外円直径

const HELP_TEXT = `
build-state.mjs - UML state machine diagram generator (.drawio + .drawio.png / .svg), zero dependency

Usage:
  node build-state.mjs --spec <spec.json> [options]

Options:
  --spec <path>         JSON spec file (see references/state.md)
  -o, --output <path>   Output file: *.drawio.png (default) or *.svg
      --xml-out <path>  Where to write the intermediate .drawio XML
                        (default: <output> without .png/.svg suffix)
      --name <name>     Diagram (page) name (default: spec title or "State Diagram")
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

/** html=1 ラベルに入れる生テキスト用（XML パース後に復元されるよう二重エスケープ） */
function escRich(s) {
  return esc(
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  );
}

// --- テキスト幅の概算（drawio2png.mjs の estimateCharWidth と同じ方針） ---

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

/** CJK / ASCII 混在テキストを maxWidth に収まる行へ折り返す */
function tokenize(text) {
  return String(text || "").match(/[\u2E80-\u30FF\u3400-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF]|[A-Za-z0-9_./:;#=()+%&!?'[\]-]+|\s+/g) || [];
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

/** 折返しを考慮した行数（CJK は任意の位置で改行可、ASCII は空白境界優先） */
function wrappedLineCount(text, fontSize, maxWidth) {
  const tokens = tokenize(text);
  let lines = 1;
  let used = 0;
  for (const tok of tokens) {
    const w = textWidth(tok, fontSize, false);
    if (used > 0 && used + w > maxWidth) {
      lines += 1;
      used = w;
    } else {
      used += w;
    }
  }
  return lines;
}

function clamp(min, v, max) {
  return Math.max(min, Math.min(max, v));
}

// 元 ID → 一意な内部セル ID の対応表は generateStateDiagramXml() 内で作る
// （createCellIdMap()）。日本語状態 ID や記号違いの ID が同じ正規形に潰れて
// 衝突しないよう、重複時は連番を付けて区別する。

function normalizeKind(kind) {
  const key = String(kind || "state").trim().toLowerCase();
  if (key === "start" || key === "initial") return "initial";
  if (key === "end" || key === "final" || key === "terminate") return "final";
  return "state";
}

function normalizeSemantic(sem) {
  const key = String(sem || "normal").trim().toLowerCase();
  return key in PALETTE ? key : "normal";
}

function normalizeTransitionKind(kind) {
  const key = String(kind || "normal").trim().toLowerCase();
  return key in TRANSITION_STYLE ? key : "normal";
}

/** `event [guard] / action` を 1 行ラベルに組む（明示 label があればそれを優先） */
function transitionLabel(t) {
  if (t.label != null && String(t.label).trim() !== "") return String(t.label);
  const parts = [];
  const ev = String(t.event || "").trim();
  const guard = String(t.guard || "").trim();
  const action = String(t.action || "").trim();
  let head = ev;
  if (guard) head += head ? ` [${guard}]` : `[${guard}]`;
  if (head) parts.push(head);
  if (action) parts.push(`/ ${action}`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// ノード計測
// ---------------------------------------------------------------------------

function measureNode(raw) {
  const kind = normalizeKind(raw.kind);
  const id = raw.id || raw.name;
  if (kind === "initial") {
    return { ...raw, id, kind, width: DOT_D, height: DOT_D, name: raw.name || "", actions: [], x: 0, y: 0 };
  }
  if (kind === "final") {
    return { ...raw, id, kind, width: FINAL_D, height: FINAL_D, name: raw.name || "", actions: [], x: 0, y: 0 };
  }
  const name = raw.name || raw.id;
  const actions = [];
  if (raw.entry) actions.push(`entry / ${raw.entry}`);
  if (raw.do) actions.push(`do / ${raw.do}`);
  if (raw.exit) actions.push(`exit / ${raw.exit}`);
  for (const line of raw.actions || []) actions.push(String(line));

  const nameW = textWidth(name, NAME_FONT, true) + 46;
  const longest = actions.reduce((m, l) => Math.max(m, textWidth(l, ACTION_FONT, false)), 0);
  const width = clamp(
    MIN_STATE_W,
    Math.max(nameW, Math.min(longest + 30, MAX_STATE_W)),
    MAX_STATE_W
  );
  let actionLines = 0;
  for (const a of actions) actionLines += wrappedLineCount(a, ACTION_FONT, width - 26);
  const height =
    HEADER_H + (actionLines ? actionLines * LINE_H + 10 : 0) + 12;
  return {
    ...raw,
    id,
    kind,
    name,
    semantic: normalizeSemantic(raw.semantic),
    actions,
    actionLines,
    width,
    height,
    x: 0,
    y: 0,
  };
}

// ---------------------------------------------------------------------------
// グリッドレイアウト
// ---------------------------------------------------------------------------

function layoutGrid(nodes) {
  const explicitRows = nodes.filter((n) => Number.isInteger(n.row)).map((n) => n.row);
  const firstAutoRow = explicitRows.length ? Math.max(...explicitRows) + 1 : 0;

  // row 未指定のノードは「入力順に 1 行 1 ノード」で縦に積む（明示 row を優先）
  let autoRow = firstAutoRow;
  for (const n of nodes) {
    if (!Number.isInteger(n.row)) {
      n.row = autoRow;
      autoRow += 1;
    }
  }
  // row 単位で col を詰める（明示 col を優先）
  const byRow = new Map();
  for (const n of nodes) {
    if (!byRow.has(n.row)) byRow.set(n.row, []);
    byRow.get(n.row).push(n);
  }
  for (const [, rowNodes] of byRow) {
    const used = new Set(rowNodes.filter((n) => Number.isInteger(n.col)).map((n) => n.col));
    let next = 0;
    for (const n of rowNodes) {
      if (Number.isInteger(n.col)) {
        n._col = n.col;
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
  return {
    width: (x > 0 ? x - H_GAP : 0) || 1,
    height: (y > 0 ? y - V_GAP : 0) || 1,
    rows,
    rowY,
    rowH,
  };
}

// ---------------------------------------------------------------------------
// エッジ（遷移）の配線計画
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

/**
 * 遷移ごとに exit / entry の辺とウェイポイントを計画する。
 *  - 自己遷移: 右側へ小さなループ
 *  - 同行の後方遷移（右 → 左）: 行の下側廊下を回る
 *  - その他: 主軸方向の辺を割り当て、直線経路が他ノードを横切れば行間廊下へ回避
 */
function planRelations(nodes, relations, grid) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kept = [];
  for (const rel of relations) {
    const s = byId.get(rel.from);
    const t = byId.get(rel.to);
    if (!s || !t) {
      console.warn(`[warn] transitions の参照先が無いためスキップ: ${rel.from} -> ${rel.to}`);
      continue;
    }
    kept.push({ ...rel, _s: s, _t: t });
  }

  // 1) 自己遷移
  for (const rel of kept) {
    if (rel.from !== rel.to) continue;
    const n = rel._s;
    const y = n.y + n.height - 12;
    rel.exitSide = "right";
    rel.entrySide = "right";
    rel.waypoints = [
      { x: n.x + n.width + 34, y },
      { x: n.x + n.width + 34, y: n.y + 12 },
    ];
  }

  // 2) 同行後方遷移（same row, target 左側）
  const backRows = new Map(); // row -> count（廊下をずらす）
  for (const rel of kept) {
    if (rel.from === rel.to) continue;
    const s = rel._s;
    const t = rel._t;
    const sameRow = s.row === t.row;
    const leftward = t.x + t.width / 2 < s.x + s.width / 2;
    if (!(sameRow && leftward)) continue;
    const row = s.row;
    const idx = backRows.get(row) || 0;
    backRows.set(row, idx + 1);
    const corridor = s._rowBand.bottom + 48 + idx * 30;
    rel.exitSide = "bottom";
    rel.entrySide = "bottom";
    rel.exitFrac = 0.5;
    rel.entryFrac = 0.5;
    rel.waypoints = [
      { x: Math.round(s.x + s.width / 2), y: Math.round(corridor) },
      { x: Math.round(t.x + t.width / 2), y: Math.round(corridor) },
    ];
  }

  // 3) 残り（順方向・縦方向）
  const sideCount = new Map();
  const pending = [];
  for (const rel of kept) {
    if (rel.exitSide) continue;
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
    pending.push(rel);
  }
  const fracUsed = new Map();
  for (const rel of pending) {
    const take = (id, side) => {
      const key = `${id}|${side}`;
      const count = sideCount.get(key) || 1;
      const idx = fracUsed.get(key) || 0;
      fracUsed.set(key, idx + 1);
      if (count === 1) return 0.5;
      return Number((0.3 + (0.4 * idx) / (count - 1)).toFixed(3));
    };
    rel.exitFrac = take(rel.from, rel.exitSide);
    rel.entryFrac = take(rel.to, rel.entrySide);
    rel._exitCount = sideCount.get(rel._exitKey) || 1;
  }

  // 4) 水平直線が他ノードを横切るときは行間廊下へ回避
  for (const rel of kept) {
    if (rel.waypoints) continue;
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
      if (rel.exitSide === "left" && n.x + n.width < s.x - 10 && n.x + n.width > t.x + t.width + 10) blocked = true;
    }
    if (!blocked) continue;
    let corridor = null;
    if (t.y + t.height < s.y) corridor = (t.y + t.height + s.y) / 2;
    else if (s.y + s.height < t.y) corridor = (s.y + s.height + t.y) / 2;
    else corridor = (grid.rowY.get(s.row) + s._rowBand.bottom) / 2 - 8;
    const xA = rel.exitSide === "right" ? s.x + s.width + 34 : s.x - 34;
    const xB = rel.exitSide === "right" ? t.x - 34 : t.x + t.width + 34;
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

function stateCell(n, ids) {
  const pal = PALETTE[n.semantic] || PALETTE.normal;
  const id = n._cellId;
  const lines = [];
  const boxStyle =
    `rounded=1;arcSize=14;html=1;whiteSpace=wrap;shadow=0;` +
    `fillColor=${pal.fill};strokeColor=${pal.stroke};strokeWidth=1.6;` +
    `align=center;verticalAlign=top;fontSize=13;fontStyle=1;fontColor=${pal.name};spacingTop=8;`;
  lines.push(
    `<mxCell id="${id}" value="${esc(n.name)}" style="${boxStyle}" vertex="1" parent="1">` +
      `<mxGeometry x="${Math.round(n.x)}" y="${Math.round(n.y)}" width="${Math.round(n.width)}" height="${Math.round(n.height)}" as="geometry"/>` +
      `</mxCell>`
  );
  if (n.actions.length) {
    const actionStyle =
      `text;html=1;whiteSpace=wrap;strokeColor=none;fillColor=none;align=left;verticalAlign=top;` +
      `spacingLeft=12;fontSize=10.5;fontColor=${ACTION_COLOR};`;
    lines.push(
      `<mxCell id="${ids.child(id, "act")}" value="${n.actions.map(escRich).join("&#10;")}" style="${actionStyle}" vertex="1" parent="${id}">` +
        `<mxGeometry x="0" y="${HEADER_H - 4}" width="${Math.round(n.width - 2)}" height="${n.actionLines * LINE_H + 8}" as="geometry"/>` +
        `</mxCell>`
    );
  }
  return lines.join("\n");
}

function pseudoCell(n, ids) {
  const id = n._cellId;
  if (n.kind === "initial") {
    const style = `ellipse;html=1;fillColor=${DOT_COLOR};strokeColor=none;`;
    return (
      `<mxCell id="${id}" value="" style="${style}" vertex="1" parent="1">` +
      `<mxGeometry x="${Math.round(n.x)}" y="${Math.round(n.y)}" width="${DOT_D}" height="${DOT_D}" as="geometry"/>` +
      `</mxCell>`
    );
  }
  const outer =
    `<mxCell id="${id}" value="" style="ellipse;html=1;fillColor=#FFFFFF;strokeColor=${DOT_COLOR};strokeWidth=2;" vertex="1" parent="1">` +
    `<mxGeometry x="${Math.round(n.x)}" y="${Math.round(n.y)}" width="${FINAL_D}" height="${FINAL_D}" as="geometry"/>` +
    `</mxCell>`;
  const d = 16;
  const off = (FINAL_D - d) / 2;
  const inner =
    `<mxCell id="${ids.child(id, "dot")}" value="" style="ellipse;html=1;fillColor=${DOT_COLOR};strokeColor=none;" vertex="1" parent="${id}">` +
    `<mxGeometry x="${off}" y="${off}" width="${d}" height="${d}" as="geometry"/>` +
    `</mxCell>`;
  return [outer, inner].join("\n");
}

function groupCell(g, ids) {
  const id = g._cellId;
  const boxStyle =
    `rounded=1;arcSize=4;html=1;whiteSpace=wrap;dashed=1;dashPattern=7 4;` +
    `fillColor=${GROUP_FILL};strokeColor=${GROUP_STROKE};strokeWidth=1;`;
  const labelStyle =
    `text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;` +
    `fontSize=10;fontStyle=2;fontColor=#6D28D9;spacingLeft=2;`;
  return [
    `<mxCell id="${id}" value="" style="${boxStyle}" vertex="1" parent="1">` +
      `<mxGeometry x="${Math.round(g.x)}" y="${Math.round(g.y)}" width="${Math.round(g.width)}" height="${Math.round(g.height)}" as="geometry"/>` +
      `</mxCell>`,
    `<mxCell id="${ids.child(id, "label")}" value="複合状態 · ${esc(g.label)}" style="${labelStyle}" vertex="1" parent="1">` +
      `<mxGeometry x="${Math.round(g.x + 14)}" y="${Math.round(g.y + 8)}" width="${Math.min(g.width - 28, 320)}" height="18" as="geometry"/>` +
      `</mxCell>`,
  ].join("\n");
}

function transitionCell(rel, index, ids) {
  const kind = normalizeTransitionKind(rel.kind);
  const id = ids.id("tr", String(index));
  const labelId = ids.id("tr", `${index}-lbl`);
  const style =
    `edgeStyle=orthogonalEdgeStyle;rounded=1;jettySize=auto;html=1;` +
    `${TRANSITION_STYLE[kind]}strokeWidth=1.6;` +
    `${portStyle(rel.exitSide, rel.exitFrac ?? 0.5)}${entryStyle(rel.entrySide, rel.entryFrac ?? 0.5)}`;
  const geo = rel.waypoints
    ? `<mxGeometry relative="1" as="geometry"><Array as="points">` +
      rel.waypoints.map((p) => `<mxPoint x="${p.x}" y="${p.y}"/>`).join("") +
      `</Array></mxGeometry>`
    : `<mxGeometry relative="1" as="geometry"/>`;
  const cells = [
    `<mxCell id="${id}" value="" style="${style}" edge="1" parent="1" ` +
      `source="${rel._s._cellId}" target="${rel._t._cellId}">${geo}</mxCell>`,
  ];

  const label = transitionLabel(rel);
  if (label.trim()) {
    const lines = wrapLabelLines(label, LABEL_FONT, LABEL_MAX_W);
    const w = Math.ceil(Math.max(...lines.map((l) => textWidth(l, LABEL_FONT, false))) + 8);
    const h = lines.length * LABEL_LINE_H + 4;
    // 縦遷移は線の実側にラベルを寄し、源ノード側（rel x = -0.5）へ置いて混雑を避ける
    const vertical = rel.exitSide === "bottom" || rel.exitSide === "top";
    let labelT = 0;
    let sign;
    if (vertical) {
      // 単線の縦遷移は左側へ置き、右側のラベル密度を下げる
      sign = -1;
      if ((rel._exitCount || 1) > 1) sign = (rel.exitFrac ?? 0.5) < 0.5 ? -1 : 1;
      labelT = -0.5;
    } else {
      sign = rel._labelSide === "neg" ? -1 : 1;
      // 折れた（ウェイポイント付き）遷移は源ノード寄りにラベルを置き、中点の混雑を避ける
      if (rel.waypoints && rel.from !== rel.to) labelT = -0.45;
    }
    const ox = vertical ? sign * (w / 2 + 12) : 0;
    const oy = vertical ? 0 : sign * -(h / 2 + 8);
    const labelStyle =
      `edgeLabel;html=1;whiteSpace=wrap;align=center;verticalAlign=middle;` +
      `fontSize=${LABEL_FONT};fontColor=${TRANSITION_LABEL_COLOR[kind]};` +
      `labelBackgroundColor=#FFFFFF;labelBorderColor=none;`;
    cells.push(
      `<mxCell id="${labelId}" value="${lines.map(escRich).join("&#10;")}" style="${labelStyle}" ` +
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
      `<mxGeometry x="${MARGIN + 6}" y="${HEADER_TOP}" width="720" height="30" as="geometry"/></mxCell>`
  );
  if (subtitle) {
    cells.push(
      `<mxCell id="${fx("subtitle")}" value="${esc(subtitle)}" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=11;fontColor=${SUBTITLE_COLOR};spacingLeft=13;" vertex="1" parent="1">` +
        `<mxGeometry x="${MARGIN + 6}" y="${HEADER_TOP + 30}" width="760" height="18" as="geometry"/></mxCell>`
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
    { type: "edge", label: "正常遷移", style: "endArrow=block;endFill=1;strokeColor=#475569;" },
    {
      type: "edge",
      label: "エラー / キャンセル遷移",
      style: "endArrow=block;endFill=1;dashed=1;dashPattern=6 3;strokeColor=#DC2626;",
    },
    { type: "dot", label: "初期状態 (initial)" },
    { type: "final", label: "終了状態 (final)" },
    { type: "group", label: "複合状態 (composite)" },
  ];
  const ROW_H = 24;
  const H = 30 + rows.length * ROW_H + 10;
  const cells = [];
  cells.push(
    `<mxCell id="${fx(`legend-box`)}" value="" style="rounded=1;arcSize=8;html=1;whiteSpace=wrap;fillColor=#FFFFFF;strokeColor=${DIVIDER_COLOR};strokeWidth=1;" vertex="1" parent="1">` +
      `<mxGeometry x="${legendX}" y="${legendY}" width="${LEGEND_W}" height="${H}" as="geometry"/></mxCell>`
  );
  cells.push(
    `<mxCell id="${fx(`legend-title`)}" value="LEGEND" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=9;fontStyle=1;fontColor=${SUBTITLE_COLOR};spacingLeft=12;" vertex="1" parent="1">` +
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
    } else if (r.type === "dot") {
      cells.push(
        `<mxCell id="${fx(`legend-e${i}`)}" value="" style="ellipse;html=1;fillColor=${DOT_COLOR};strokeColor=none;" vertex="1" parent="1">` +
          `<mxGeometry x="${legendX + 30}" y="${cy - 8}" width="16" height="16" as="geometry"/></mxCell>`
      );
    } else if (r.type === "final") {
      cells.push(
        `<mxCell id="${fx(`legend-e${i}`)}" value="" style="ellipse;html=1;fillColor=#FFFFFF;strokeColor=${DOT_COLOR};strokeWidth=1.6;" vertex="1" parent="1">` +
          `<mxGeometry x="${legendX + 28}" y="${cy - 10}" width="20" height="20" as="geometry"/></mxCell>` +
          `<mxCell id="${fx(`legend-e${i}d`)}" value="" style="ellipse;html=1;fillColor=${DOT_COLOR};strokeColor=none;" vertex="1" parent="1">` +
          `<mxGeometry x="${legendX + 33}" y="${cy - 5}" width="10" height="10" as="geometry"/></mxCell>`
      );
    } else {
      cells.push(
        `<mxCell id="${fx(`legend-e${i}`)}" value="" style="rounded=1;arcSize=8;html=1;dashed=1;dashPattern=7 4;fillColor=${GROUP_FILL};strokeColor=${GROUP_STROKE};strokeWidth=1;" vertex="1" parent="1">` +
          `<mxGeometry x="${legendX + 14}" y="${cy - 9}" width="40" height="18" as="geometry"/></mxCell>`
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
 * @param {object} spec JSON spec（references/state.md 参照）
 * @param {{title?: string, subtitle?: string, name?: string}} [opts]
 * @returns {string} mxfile XML
 */
export function generateStateDiagramXml(spec, opts = {}) {
  if (!spec || !Array.isArray(spec.states) || spec.states.length === 0) {
    throw new Error("spec.states は 1 件以上の配列である必要があります");
  }
  const title = opts.title || spec.title || "State Diagram";
  const subtitle = opts.subtitle ?? spec.subtitle ?? "";

  const nodes = spec.states.map(measureNode);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) throw new Error("states[].id が重複しています");

  const grid = layoutGrid(nodes);
  const contentLeft = MARGIN + CONTENT_PAD_LEFT;
  const contentTop = HEADER_TOP + HEADER_GAP + CONTENT_PAD_TOP;
  for (const n of nodes) {
    n.x += contentLeft;
    n.y += contentTop;
    n._rowBand = {
      top: n._rowBand.top + contentTop,
      bottom: n._rowBand.bottom + contentTop,
    };
  }
  const contentRight = contentLeft + grid.width;
  const contentBottom = contentTop + grid.height;

  // 複合状態グループ（メンバーノードの外接矩形）
  const groupDefs = new Map();
  for (const g of spec.groups || []) groupDefs.set(g.id, { ...g });
  for (const n of nodes) {
    if (n.group && !groupDefs.has(n.group)) groupDefs.set(n.group, { id: n.group, label: n.group });
  }
  const groups = [];
  for (const g of groupDefs.values()) {
    const members = nodes.filter((n) => n.group === g.id);
    if (!members.length) continue;
    const padX = 26;
    const padTop = 44;
    const padBottom = 26;
    const minX = Math.min(...members.map((m) => m.x));
    const minY = Math.min(...members.map((m) => m.y));
    const maxX = Math.max(...members.map((m) => m.x + m.width));
    const maxY = Math.max(...members.map((m) => m.y + m.height));
    groups.push({
      ...g,
      label: g.label || g.id,
      x: minX - padX,
      y: minY - padTop,
      width: maxX - minX + padX * 2,
      height: maxY - minY + padTop + padBottom,
    });
  }

  const relations = planRelations(nodes, spec.transitions || [], grid);

  // 元 ID → 内部セル ID の対応表（状態・複合状態・遷移の両端で共有）
  const ids = createCellIdMap();
  // 固定セルを先に予約。状態・疑似状態・グループ・遷移・ラベルも同じ
  // アロケーターを通すため mxCell ID の重複は起きない。子セルは `~` 区切り。
  const fx = (name) => ids.fixed(name);
  for (let i = 0; i < 10; i += 1) { fx(`legend-e${i}`); fx(`legend-e${i}d`); fx(`legend-t${i}`); }
  for (const n of nodes) n._cellId = ids.id("st", n.id);

  const groupRight = groups.length ? Math.max(...groups.map((g) => g.x + g.width)) : contentRight;
  const groupBottom = groups.length ? Math.max(...groups.map((g) => g.y + g.height)) : contentBottom;
  const contentW = Math.max(contentRight, groupRight);
  const canvasW = Math.max(contentW + LEGEND_BAND_GAP + LEGEND_W + MARGIN, 820);
  const legendX = Math.max(contentW + LEGEND_BAND_GAP, canvasW - MARGIN - LEGEND_W);
  const legendY = HEADER_TOP + HEADER_GAP + 34;
  const legendH = legendCells(legendX, legendY, fx).height;
  const canvasH = Math.max(contentBottom, groupBottom, legendY + legendH) + MARGIN;

  const cells = headerCells(title, subtitle, canvasW - MARGIN, fx);
  cells.push(legendCells(legendX, legendY, fx).cells);
  for (const g of groups) {
    g._cellId = ids.id("grp", g.id);
    cells.push(groupCell(g, ids));
  }
  for (const n of nodes) cells.push(n.kind === "state" ? stateCell(n, ids) : pseudoCell(n, ids));
  relations.forEach((rel, i) => {
    ids.id("tr", String(i));
    cells.push(transitionCell(rel, i, ids));
  });

  const diagramName = opts.name || title || "State Diagram";
  return [
    `<mxfile host="drawio-state-skill" agent="drawio-state-skill" version="1.0.0" type="device">`,
    `  <diagram name="${esc(diagramName)}" id="state-diagram">`,
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

  const raw = await fsp.readFile(values.spec, "utf8");
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (err) {
    throw new Error(`spec JSON の解析に失敗しました (${values.spec}): ${err.message}`);
  }

  const xml = generateStateDiagramXml(spec, {
    title: values.title,
    subtitle: values.subtitle,
    name: values.name,
  });

  const output = values.output || "state-diagram.drawio.png";
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
    await fsp.mkdir(path.dirname(resolveWriteTarget(xmlOut)), { recursive: true });
    await writeFileAtomic(xmlOut, xml);
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
