#!/usr/bin/env node
/**
 * build-er.mjs
 * Generates a polished Crow's Foot ER diagram (.drawio XML + .drawio.png/.svg)
 * from SQL DDL / Prisma files (`--schema`) or a curated JSON spec (`--spec`).
 *
 * - Zero npm dependencies (Node.js stdlib + bundled drawio2png.mjs)
 * - Crow's Foot markers via draw.io native ER arrows
 *   (ERmandOne / ERzeroToOne / ERoneToMany / ERzeroToMany)
 * - Auto column/row layout (parents left, children right) with explicit
 *   `row` / `col` overrides, port distribution and bottom bus lanes for
 *   edges spanning multiple columns.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { convertXmlToPng, convertXmlToSvg } from "./drawio2png.mjs";
import { scanSchemaFiles, collectSchemaInputFiles } from "./scan-schema.mjs";
import {
  assertOutputsDistinctFromInputs,
  createCellIdMap,
  emitDiagramFiles,
  isDirectRun,
  resolveWriteTarget,
  writeFileAtomic,
} from "./diagram-shared.mjs";

// ---------------------------------------------------------------------------
// constants & small helpers
// ---------------------------------------------------------------------------

function escapeXml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const COLOR = {
  bg: "#FFFFFF",
  accent: "#0D9488",
  title: "#0F172A",
  subtitle: "#475569",
  divider: "#E2E8F0",
  cardBorder: "#E2E8F0",
  rowZebra: "#F8FAFC",
  rowLine: "#EEF2F6",
  colNamePk: "#0F172A",
  colName: "#1E293B",
  colType: "#64748B",
  colNn: "#94A3B8",
  edge: "#475569",
  edgeLabel: "#475569",
  footer: "#94A3B8",
  legendText: "#475569",
};

const BADGE_STYLE = {
  PK: "fillColor=#FEF3C7;strokeColor=none;fontColor=#D97706;fontStyle=1;",
  FK: "fillColor=#DBEAFE;strokeColor=none;fontColor=#2563EB;fontStyle=1;",
  UK: "fillColor=#F3E8FF;strokeColor=none;fontColor=#7C3AED;fontStyle=1;",
};

const ROLE_COLORS = {
  root: "#0F766E", // 親 / マスタテーブル（外部キーを持たない）
  mid: "#4338CA", // 中間テーブル（親でも子でもある）
  leaf: "#1D4ED8", // 末端テーブル（外部キーを持つ）
  orphan: "#0F172A", // 孤立テーブル
};

const DOMAIN_PALETTE = ["#0F766E", "#1D4ED8", "#4338CA", "#0E7490", "#7C3AED", "#B45309"];

// relation.cardinality -> [startArrow (parent end), endArrow (child end)]
const CARDINALITY_MARKERS = {
  "1:N": ["ERmandOne", "ERoneToMany"],
  "1:1": ["ERmandOne", "ERmandOne"],
  "1:0..1": ["ERmandOne", "ERzeroToOne"],
  "1:0..N": ["ERmandOne", "ERzeroToMany"],
  "0..1:N": ["ERzeroToOne", "ERoneToMany"],
  "0..1:0..1": ["ERzeroToOne", "ERzeroToOne"],
  "0..1:0..N": ["ERzeroToOne", "ERzeroToMany"],
};

/** Approximate rendered text width (Helvetica-ish metrics). */
function textWidth(str, fontSize, mono = false) {
  let w = 0;
  for (const ch of String(str)) {
    if (/[\u3000-\u30FF\u3400-\u9FFF\uFF00-\uFFEF]/.test(ch)) w += fontSize;
    // 等幅（Courier New）は英数字も記号も同じ送り幅。`i` や `.` を細めて測ると
    // 列幅が足りず、列名と型名が重なって描画される（shipping_address_iduuid）。
    else if (mono) w += fontSize * 0.62;
    else if (ch === " ") w += fontSize * 0.3;
    else if (ch === ch.toUpperCase() && /[A-Z]/.test(ch)) w += fontSize * 0.66;
    else if (/[ilj.,'!|()~]/.test(ch)) w += fontSize * 0.3;
    else if (/[mwMW]/.test(ch)) w += fontSize * 0.85;
    else w += fontSize * 0.55;
  }
  return w;
}

// ---------------------------------------------------------------------------
// layout constants
// ---------------------------------------------------------------------------

const OUTER_PAD = 36;
const HEADER_BAND_H = 78;
const TITLE_FONT = 18;
const SUB_FONT = 11;

const CARD_MIN_W = 232;
const HEADER_H = 34;
const ROW_H = 24;
const CARD_BOTTOM_PAD = 8;
const PAD_X = 12;
const BADGE_W = 28;
const BADGE_GAP = 4;
const NAME_TYPE_GAP = 12;
const NN_COL_W = 24;

const GUTTER_X = 110; // horizontal gutter between columns (>= 100)
const GUTTER_Y = 78; // vertical gutter between stacked tables (>= 70)

const LEGEND_W = 218;

// ---------------------------------------------------------------------------
// card metrics (auto width)
// ---------------------------------------------------------------------------

function columnBadges(col) {
  const badges = [];
  if (col.pk) badges.push("PK");
  if (col.fk) badges.push("FK");
  if (col.unique && !col.pk) badges.push("UK");
  return badges;
}

function computeCardMetrics(table) {
  const cols = table.columns || [];
  const maxBadges = Math.max(1, ...cols.map((c) => columnBadges(c).length));
  const badgeAreaW = maxBadges * BADGE_W + Math.max(0, maxBadges - 1) * BADGE_GAP;
  const nameX = PAD_X + badgeAreaW + 10;

  let nameW = textWidth("id", 11, true);
  let typeW = textWidth("type", 10, true);
  for (const c of cols) {
    nameW = Math.max(nameW, textWidth(c.name, c.pk ? 11.5 : 11, true) + (c.pk ? 4 : 0));
    typeW = Math.max(typeW, textWidth(c.type || "", 10, true));
  }
  const typeX = nameX + nameW + NAME_TYPE_GAP;
  const width = Math.max(CARD_MIN_W, typeX + typeW + 10 + NN_COL_W + PAD_X);

  const pkCount = cols.filter((c) => c.pk).length;
  const showPkDivider = pkCount > 0 && pkCount < cols.length &&
    cols.findIndex((c) => !c.pk) === pkCount && cols.slice(0, pkCount).every((c) => c.pk);
  const height = HEADER_H + 6 + cols.length * ROW_H + (showPkDivider ? 6 : 0) + CARD_BOTTOM_PAD;

  return { width, height, nameX, typeX, typeW, showPkDivider, badgeAreaW };
}

// ---------------------------------------------------------------------------
// rank / column / row assignment
// ---------------------------------------------------------------------------

function assignLayout(tables, relations) {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const rels = relations.filter((r) => byName.has(r.from) && byName.has(r.to) && r.from !== r.to);

  const childrenOf = new Map();
  const parentsOf = new Map();
  for (const t of tables) {
    childrenOf.set(t.name, []);
    parentsOf.set(t.name, []);
  }
  for (const r of rels) {
    childrenOf.get(r.from).push(r.to);
    parentsOf.get(r.to).push(r.from);
  }

  // 1. longest-path depth from roots (cycle-safe relaxation)
  const depth = new Map(tables.map((t) => [t.name, 0]));
  for (let iter = 0; iter < tables.length + 1; iter += 1) {
    let changed = false;
    for (const r of rels) {
      const d = depth.get(r.from) + 1;
      if (d > depth.get(r.to) && d <= tables.length) {
        depth.set(r.to, d);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 2. pull leaf-ish parents right towards their children (min children - 1)
  const rank = new Map(depth);
  for (let iter = 0; iter < tables.length; iter += 1) {
    let changed = false;
    for (const t of tables) {
      const kids = childrenOf.get(t.name);
      if (!kids.length) continue;
      const maxParent = parentsOf.get(t.name).reduce((mx, p) => Math.max(mx, rank.get(p)), -1);
      const allowed = Math.min(...kids.map((k) => rank.get(k) - 1));
      const target = Math.max(allowed, maxParent + 1);
      if (target > rank.get(t.name) && target <= allowed) {
        rank.set(t.name, target);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return { rank, rels, childrenOf, parentsOf, byName };
}

// ---------------------------------------------------------------------------
// XML generation
// ---------------------------------------------------------------------------

export function generateErDrawioXml(spec) {
  const tables = (Array.isArray(spec.tables) ? spec.tables : []).map((t) => ({
    ...t,
    name: t.name || t.id || "table",
    columns: t.columns || [],
  }));
  const relations = (Array.isArray(spec.relations) ? spec.relations : [])
    .filter(
      (r) => tables.some((t) => t.name === r.from) && tables.some((t) => t.name === r.to)
    )
    .map((r, i) => ({ ...r, id: r.id || `rel_${i + 1}` }));

  const title = spec.title || "データベース ER 図（エンティティ関係図）";
  const subtitle =
    spec.subtitle ||
    `Crow's Foot 記法 · ${spec.sources && spec.sources.length ? spec.sources.join(" / ") : "JSON spec から生成"}`;

  const metrics = new Map(tables.map((t) => [t.name, computeCardMetrics(t)]));
  const { rank, rels, childrenOf, parentsOf } = assignLayout(tables, relations);

  // ----- header colors (domain or role based) -----
  const useDomain = tables.some((t) => t.domain);
  const domainColor = new Map();
  const headerColorOf = (t) => {
    if (t.color) return t.color;
    if (useDomain && t.domain) {
      if (!domainColor.has(t.domain)) {
        domainColor.set(t.domain, DOMAIN_PALETTE[domainColor.size % DOMAIN_PALETTE.length]);
      }
      return domainColor.get(t.domain);
    }
    const hasKids = childrenOf.get(t.name).length > 0;
    const hasParents = parentsOf.get(t.name).length > 0;
    if (hasKids && hasParents) return ROLE_COLORS.mid;
    if (hasKids) return ROLE_COLORS.root;
    if (hasParents) return ROLE_COLORS.leaf;
    return ROLE_COLORS.orphan;
  };

  // ----- column buckets -----
  const explicit = tables.filter((t) => Number.isInteger(t.col));
  const auto = tables.filter((t) => !Number.isInteger(t.col));
  const columns = new Map(); // col index -> [tables]
  const push = (ci, t) => {
    if (!columns.has(ci)) columns.set(ci, []);
    columns.get(ci).push(t);
  };
  for (const t of explicit) push(t.col, t);

  const maxRank = auto.length ? Math.max(...auto.map((t) => rank.get(t.name))) : -1;

  // sort auto tables per rank column by relation structure, place by barycenter
  const autoByRank = new Map();
  for (const t of auto) {
    const r = Math.min(rank.get(t.name), maxRank);
    if (!autoByRank.has(r)) autoByRank.set(r, []);
    autoByRank.get(r).push(t);
  }

  const posOf = new Map(); // name -> {x, y, w, h, col, row}

  // merge auto rank columns into the column buckets
  const autoCols = [...autoByRank.keys()].sort((a, b) => a - b);
  for (const ci of autoCols) {
    if (columns.has(ci)) {
      for (const t of autoByRank.get(ci)) columns.get(ci).push(t);
    } else {
      columns.set(ci, autoByRank.get(ci));
    }
  }
  const finalColIds = [...columns.keys()].sort((a, b) => a - b);

  // column x coordinates
  const colW = new Map(); // col id -> width
  const colWidthOf = (list) => Math.max(...list.map((t) => metrics.get(t.name).width));
  for (const ci of finalColIds) colW.set(ci, colWidthOf(columns.get(ci)));

  const colX = new Map();
  let x = OUTER_PAD;
  for (const ci of finalColIds) {
    colX.set(ci, x);
    x += colW.get(ci) + GUTTER_X;
  }
  const contentRight = x - GUTTER_X;

  // canvas size / header band / legend geometry (legend must not overlap cards)
  const legendH = 136;
  const titleW = textWidth(title, TITLE_FONT);
  const canvasW = Math.ceil(
    Math.max(
      contentRight + OUTER_PAD,
      OUTER_PAD * 2 + LEGEND_W + 24,
      OUTER_PAD * 2 + 18 + titleW + 24 + LEGEND_W
    )
  );
  const legendPos = { x: canvasW - OUTER_PAD - LEGEND_W, y: OUTER_PAD - 4 };
  const sepY = Math.max(OUTER_PAD + HEADER_BAND_H, legendPos.y + legendH) + 14;

  // multi-column-span edges are routed through lanes just below the divider
  const selfRels = relations.filter((r) => r.from === r.to);
  const normalRels = relations.filter((r) => r.from !== r.to);
  const colIndex = new Map(finalColIds.map((ci, i) => [ci, i]));
  const colIdOf = new Map();
  for (const ci of finalColIds) for (const t of columns.get(ci)) colIdOf.set(t.name, ci);
  const busEdges = normalRels.filter((r) => {
    const a = colIdOf.get(r.from);
    const b = colIdOf.get(r.to);
    return a !== undefined && b !== undefined && Math.abs(colIndex.get(a) - colIndex.get(b)) > 1;
  });
  const busLaneBaseY = sepY + 16;
  const busY = new Map();
  busEdges.forEach((r, i) => busY.set(r.id, busLaneBaseY + i * 20));
  const contentTop = Math.max(
    OUTER_PAD + HEADER_BAND_H + 20,
    legendPos.y + legendH + 18,
    busEdges.length ? busLaneBaseY + busEdges.length * 20 + 20 : 0
  );

  // y stacking per column (explicit `row` respected, auto tables ordered by
  // barycenter of already-placed neighbours to minimise edge crossings)
  for (const ci of finalColIds) {
    const list = columns.get(ci);
    let y = contentTop;
    const place = (t, row) => {
      const m = metrics.get(t.name);
      posOf.set(t.name, { x: colX.get(ci), y, w: m.width, h: m.height, col: ci, row });
      y += m.height + GUTTER_Y;
    };
    const explicitRow = list.filter((t) => Number.isInteger(t.row)).sort((a, b) => a.row - b.row);
    const rest = list.filter((t) => !Number.isInteger(t.row));
    rest.forEach((t, i) => {
      const neigh = [...(parentsOf.get(t.name) || []), ...(childrenOf.get(t.name) || [])]
        .map((n) => posOf.get(n))
        .filter(Boolean);
      t._sortKey = neigh.length
        ? neigh.reduce((s, p) => s + p.y + p.h / 2, 0) / neigh.length
        : Number.MAX_SAFE_INTEGER * 0.5 + i;
    });
    rest.sort((a, b) => a._sortKey - b._sortKey);
    for (const t of explicitRow) place(t, t.row);
    for (const t of rest) place(t, -1);
  }

  const contentBottom = Math.max(
    ...[...posOf.values()].map((p) => p.y + p.h),
    contentTop + 200
  );

  // ----- edges -----
  const exitGroups = new Map(); // table -> [edges]
  const entryGroups = new Map();
  for (const r of normalRels) {
    if (!exitGroups.has(r.from)) exitGroups.set(r.from, []);
    exitGroups.get(r.from).push(r);
    if (!entryGroups.has(r.to)) entryGroups.set(r.to, []);
    entryGroups.get(r.to).push(r);
  }
  const portFraction = new Map(); // `${edgeId}:exit|entry` -> fraction
  for (const [tname, list] of exitGroups) {
    list.sort((a, b) => {
      const pa = posOf.get(a.to);
      const pb = posOf.get(b.to);
      return (pa ? pa.y : 0) - (pb ? pb.y : 0);
    });
    list.forEach((r, i) => portFraction.set(`${r.id}:exit`, (i + 1) / (list.length + 1)));
  }
  const busEdgeIds = new Set(busEdges.map((r) => r.id));
  for (const [tname, list] of entryGroups) {
    list.sort((a, b) => {
      // lane-routed edges enter from the top of the side (they arrive from the
      // lane above the cards), straight edges follow their source order
      const busA = busEdgeIds.has(a.id) ? 0 : 1;
      const busB = busEdgeIds.has(b.id) ? 0 : 1;
      if (busA !== busB) return busA - busB;
      const pa = posOf.get(a.from);
      const pb = posOf.get(b.from);
      return (pa ? pa.y : 0) - (pb ? pb.y : 0);
    });
    list.forEach((r, i) => portFraction.set(`${r.id}:entry`, (i + 1) / (list.length + 1)));
  }

  const diagramBottom = contentBottom + 24;
  const diagramH = diagramBottom + 46;

  // ----- build xml -----
  // 単一の ID アロケーターでキャンバス固定要素・テーブル・子セル・エッジの
  // 全 mxCell ID を採番する（固定語と正規名が潰れても衝突しない）。
  // 子セル ID は `~` を含む形になり、`~` は sanitizeIdPart() が生成しないため、
  // 表名 `title` のヘッダー（card_title~hdr）が固定セル hdr_title と衝突しない。
  const idAllocator = createCellIdMap();
  const fx = (name) => idAllocator.fixed(name);
  const lines = [];
  lines.push(`<mxfile host="drawio-er-skill" version="1.0.0" type="device">`);
  lines.push(`  <diagram id="er-diagram-1" name="${escapeXml(title)}">`);
  lines.push(
    `    <mxGraphModel dx="1600" dy="1000" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${Math.ceil(canvasW)}" pageHeight="${Math.ceil(diagramH)}" math="0" shadow="0" background="${COLOR.bg}">`
  );
  lines.push(`      <root>`);
  lines.push(`        <mxCell id="0" />`);
  lines.push(`        <mxCell id="1" parent="0" />`);

  // 1. header band
  lines.push(
    `        <mxCell id="${escapeXml(fx("hdr_accent"))}" value="" style="rounded=0;html=1;fillColor=${COLOR.accent};strokeColor=none;" vertex="1" parent="1">`
  );
  lines.push(
    `          <mxGeometry x="${OUTER_PAD}" y="${OUTER_PAD + 4}" width="6" height="46" as="geometry" />`
  );
  lines.push(`        </mxCell>`);
  lines.push(
    `        <mxCell id="${escapeXml(fx("hdr_title"))}" value="${escapeXml(title)}" style="text;html=1;align=left;verticalAlign=middle;fontSize=${TITLE_FONT};fontStyle=1;fontColor=${COLOR.title};" vertex="1" parent="1">`
  );
  lines.push(
    `          <mxGeometry x="${OUTER_PAD + 18}" y="${OUTER_PAD}" width="${Math.min(760, Math.ceil(textWidth(title, TITLE_FONT)) + 20)}" height="30" as="geometry" />`
  );
  lines.push(`        </mxCell>`);
  lines.push(
    `        <mxCell id="${escapeXml(fx("hdr_subtitle"))}" value="${escapeXml(subtitle)}" style="text;html=1;align=left;verticalAlign=middle;fontSize=${SUB_FONT};fontColor=${COLOR.subtitle};" vertex="1" parent="1">`
  );
  lines.push(
    `          <mxGeometry x="${OUTER_PAD + 19}" y="${OUTER_PAD + 32}" width="${Math.min(860, Math.ceil(textWidth(subtitle, SUB_FONT, true)) + 24)}" height="20" as="geometry" />`
  );
  lines.push(`        </mxCell>`);
  lines.push(
    `        <mxCell id="${escapeXml(fx("hdr_divider"))}" value="" style="rounded=0;html=1;fillColor=${COLOR.divider};strokeColor=none;" vertex="1" parent="1">`
  );
  lines.push(
    `          <mxGeometry x="${OUTER_PAD}" y="${sepY}" width="${Math.ceil(canvasW - OUTER_PAD * 2)}" height="1" as="geometry" />`
  );
  lines.push(`        </mxCell>`);

  // 2. legend box (top-right, compact)
  lines.push(
    `        <mxCell id="${escapeXml(fx("lg_box"))}" value="" style="rounded=1;arcSize=10;html=1;fillColor=#FFFFFF;strokeColor=${COLOR.divider};" vertex="1" parent="1">`
  );
  lines.push(
    `          <mxGeometry x="${legendPos.x}" y="${legendPos.y}" width="${LEGEND_W}" height="${legendH}" as="geometry" />`
  );
  lines.push(`        </mxCell>`);
  lines.push(
    `        <mxCell id="${escapeXml(fx("lg_title"))}" value="凡例" style="text;html=1;align=left;verticalAlign=middle;fontSize=10;fontStyle=1;fontColor=${COLOR.title};" vertex="1" parent="1">`
  );
  lines.push(
    `          <mxGeometry x="${legendPos.x + 10}" y="${legendPos.y + 6}" width="60" height="16" as="geometry" />`
  );
  lines.push(`        </mxCell>`);

  const legendBadge = (key, desc, i) => {
    const ry = legendPos.y + 26 + i * 20;
    lines.push(
      `        <mxCell id="${escapeXml(fx(`lg_${key}`))}" value="${key}" style="rounded=1;arcSize=40;html=1;fontSize=9;${BADGE_STYLE[key]}verticalAlign=middle;align=center;" vertex="1" parent="1">`
    );
    lines.push(
      `          <mxGeometry x="${legendPos.x + 12}" y="${ry}" width="30" height="14" as="geometry" />`
    );
    lines.push(`        </mxCell>`);
    lines.push(
      `        <mxCell id="${escapeXml(fx(`lg_${key}_t`))}" value="${escapeXml(desc)}" style="text;html=1;align=left;verticalAlign=middle;fontSize=10;fontColor=${COLOR.legendText};" vertex="1" parent="1">`
    );
    lines.push(
      `          <mxGeometry x="${legendPos.x + 52}" y="${ry - 2}" width="${LEGEND_W - 60}" height="18" as="geometry" />`
    );
    lines.push(`        </mxCell>`);
  };
  legendBadge("PK", "Primary Key", 0);
  legendBadge("FK", "Foreign Key", 1);
  legendBadge("UK", "Unique Key", 2);

  const legendEdge = (i, startArrow, endArrow, label) => {
    const y = legendPos.y + 88 + i * 20;
    lines.push(
      `        <mxCell id="${escapeXml(fx(`lg_e${i}`))}" value="" style="html=1;endArrow=${endArrow};startArrow=${startArrow};startFill=0;endFill=0;strokeColor=${COLOR.edge};strokeWidth=1.4;" edge="1" parent="1">`
    );
    lines.push(`          <mxGeometry relative="1" as="geometry">`);
    lines.push(
      `            <mxPoint x="${legendPos.x + 16}" y="${y}" as="sourcePoint" />`
    );
    lines.push(
      `            <mxPoint x="${legendPos.x + 116}" y="${y}" as="targetPoint" />`
    );
    lines.push(`          </mxGeometry>`);
    lines.push(`        </mxCell>`);
    lines.push(
      `        <mxCell id="${escapeXml(fx(`lg_e${i}_t`))}" value="${escapeXml(label)}" style="text;html=1;align=left;verticalAlign=middle;fontSize=10;fontColor=${COLOR.legendText};" vertex="1" parent="1">`
    );
    lines.push(
      `          <mxGeometry x="${legendPos.x + 126}" y="${y - 8}" width="80" height="16" as="geometry" />`
    );
    lines.push(`        </mxCell>`);
  };
  legendEdge(0, "ERmandOne", "ERoneToMany", "1 : N");
  legendEdge(1, "ERmandOne", "ERzeroToMany", "1 : 0..N");
  legendEdge(2, "ERzeroToOne", "ERzeroToMany", "0..1 : 0..N");

  // 3. table cards
  // カード本体・ヘッダー・行要素はすべてカードセルの「子」として親 CELL ID +
  // カード原点からの相対座標で出力する。draw.io でカードをドラッグすると
  // ヘッダー・行・バッジがまとめて付いてくる（再編集時の親子追従）。
  // ID は単一のアロケーターで採番し、子セルは `~` 区切り（sanitizeIdPart() が
  // 生成しない文字）なので固定セル（hdr_title など）や別テーブルと衝突しない。
  const tableKey = (name) => idAllocator.unique(name);
  for (const t of tables) tableKey(t.name);
  const cardIds = new Map();

  for (const t of tables) {
    const p = posOf.get(t.name);
    const m = metrics.get(t.name);
    const color = headerColorOf(t);
    const idSafe = tableKey(t.name);
    const esc = (v) => escapeXml(String(v));

    // card body（このセルが子要素全員の parent）
    const card = idAllocator.fixed(`card_${idSafe}`);
    cardIds.set(t.name, card);
    lines.push(
      `        <mxCell id="${esc(card)}" value="" style="rounded=1;arcSize=8;html=1;fillColor=#FFFFFF;strokeColor=${COLOR.cardBorder};whiteSpace=wrap;" vertex="1" parent="1">`
    );
    lines.push(
      `          <mxGeometry x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" as="geometry" />`
    );
    lines.push(`        </mxCell>`);

    // 子セルはカード原点からの相対座標で置く
    const child = (suffix) => idAllocator.child(card, suffix);
    const pushChild = (suffix, value, style, x, y, w, h) => {
      lines.push(
        `        <mxCell id="${esc(child(suffix))}" value="${value}" style="${style}" vertex="1" parent="${esc(card)}">`
      );
      lines.push(
        `          <mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry" />`
      );
      lines.push(`        </mxCell>`);
    };

    // header (rounded top + square bottom cover)
    pushChild("hdr", "", `rounded=1;arcSize=22;html=1;fillColor=${color};strokeColor=none;`, 0, 0, p.w, HEADER_H);
    pushChild(
      "hdrcover",
      "",
      `rounded=0;html=1;fillColor=${color};strokeColor=none;`,
      0,
      HEADER_H - 8,
      p.w,
      8
    );
    pushChild(
      "hdrname",
      esc(t.name),
      `text;html=1;align=left;verticalAlign=middle;fontSize=12.5;fontStyle=1;fontColor=#FFFFFF;`,
      PAD_X,
      0,
      Math.ceil(p.w * 0.62),
      HEADER_H
    );
    if (t.displayName) {
      pushChild(
        "hdrdisp",
        esc(t.displayName),
        `text;html=1;align=right;verticalAlign=middle;fontSize=10;fontColor=#E2E8F0;`,
        Math.ceil(p.w * 0.38),
        0,
        Math.ceil(p.w * 0.62) - PAD_X,
        HEADER_H
      );
    }

    // rows
    let ry = HEADER_H + 6;
    const cols = t.columns || [];
    cols.forEach((c, idx) => {
      const zebra = idx % 2 === 1;
      if (zebra) {
        pushChild(
          `r${idx}`,
          "",
          `rounded=0;html=1;fillColor=${COLOR.rowZebra};strokeColor=none;`,
          1,
          ry,
          p.w - 2,
          ROW_H
        );
      }

      // badges
      columnBadges(c).forEach((b, bi) => {
        pushChild(
          `r${idx}:${b}`,
          b,
          `rounded=1;arcSize=40;html=1;fontSize=9;${BADGE_STYLE[b]}verticalAlign=middle;align=center;spacing=0;`,
          PAD_X + bi * (BADGE_W + BADGE_GAP),
          ry + (ROW_H - 14) / 2,
          BADGE_W,
          14
        );
      });

      // column name
      pushChild(
        `r${idx}:nm`,
        esc(c.name),
        `text;html=1;align=left;verticalAlign=middle;fontSize=${c.pk ? 11.5 : 11};fontStyle=${c.pk ? 1 : 0};fontColor=${c.pk ? COLOR.colNamePk : COLOR.colName};fontFamily=Courier New;`,
        m.nameX,
        ry,
        Math.ceil(m.typeX - m.nameX) - 4,
        ROW_H
      );

      // data type
      pushChild(
        `r${idx}:ty`,
        esc(c.type || ""),
        `text;html=1;align=left;verticalAlign=middle;fontSize=10;fontColor=${COLOR.colType};fontFamily=Courier New;`,
        m.typeX,
        ry,
        Math.ceil(p.w - m.typeX - NN_COL_W - PAD_X),
        ROW_H
      );

      // NN marker (NOT NULL on non-PK columns)
      if (c.notNull && !c.pk) {
        pushChild(
          `r${idx}:nn`,
          "NN",
          `text;html=1;align=right;verticalAlign=middle;fontSize=8.5;fontColor=${COLOR.colNn};`,
          p.w - NN_COL_W - PAD_X,
          ry,
          NN_COL_W,
          ROW_H
        );
      }

      // thin baseline under each row
      if (idx < cols.length - 1) {
        pushChild(
          `r${idx}:ln`,
          "",
          `rounded=0;html=1;fillColor=${COLOR.rowLine};strokeColor=none;`,
          1,
          ry + ROW_H,
          p.w - 2,
          1
        );
      }

      ry += ROW_H;
      if (m.showPkDivider && idx === cols.findIndex((c2) => !c2.pk) - 1) {
        pushChild(
          "pkdiv",
          "",
          `rounded=0;html=1;fillColor=${COLOR.divider};strokeColor=none;`,
          1,
          ry + 2,
          p.w - 2,
          1
        );
        ry += 6;
      }
    });
  }

  // 4. relations
  const edgeStyleBase = (r) => {
    const [startArrow, endArrow] = CARDINALITY_MARKERS[r.cardinality || "1:N"] || CARDINALITY_MARKERS["1:N"];
    return `html=1;endArrow=${r.endArrow || endArrow};startArrow=${r.startArrow || startArrow};startFill=0;endFill=0;strokeColor=${COLOR.edge};strokeWidth=1.5;fontSize=10;fontColor=${COLOR.edgeLabel};labelBackgroundColor=#FFFFFF;verticalLabelPosition=middle;`;
  };

  const cardId = (name) => cardIds.get(name) || "";
  let edgeSeq = 0;
  const pushEdge = (r, extraStyle, waypoints, sourcePoint, targetPoint) => {
    // エッジ ID も同一アロケーターで採番する。`注文` / `顧客` のように正規形が
    // 潰れる日本語 ID でも、宣言順の連番を交えた候補で必ず一意になる。
    const edgeId = idAllocator.id("e", `${r.id || "rel"}#${edgeSeq++}`);
    let ends = "";
    if (!sourcePoint) {
      ends += ` source="${escapeXml(cardId(r.from))}" target="${escapeXml(cardId(r.to))}"`;
    }
    lines.push(
      `        <mxCell id="${edgeId}" value="${escapeXml(r.label || "")}" style="${escapeXml(extraStyle)}" edge="1" parent="1"${ends}>`
    );
    if (sourcePoint || waypoints?.length) {
      lines.push(`          <mxGeometry relative="1" as="geometry">`);
      if (sourcePoint) {
        lines.push(
          `            <mxPoint x="${sourcePoint.x}" y="${sourcePoint.y}" as="sourcePoint" />`
        );
        lines.push(
          `            <mxPoint x="${targetPoint.x}" y="${targetPoint.y}" as="targetPoint" />`
        );
      }
      if (waypoints?.length) {
        lines.push(`            <Array as="points">`);
        for (const wp of waypoints) {
          lines.push(`              <mxPoint x="${Math.round(wp.x)}" y="${Math.round(wp.y)}" />`);
        }
        lines.push(`            </Array>`);
      }
      lines.push(`          </mxGeometry>`);
    } else {
      lines.push(`          <mxGeometry relative="1" as="geometry" />`);
    }
    lines.push(`        </mxCell>`);
  };

  for (const r of normalRels) {
    const ps = posOf.get(r.from);
    const pt = posOf.get(r.to);
    if (!ps || !pt) continue;
    const fExit = portFraction.get(`${r.id}:exit`) ?? 0.5;
    const fEntry = portFraction.get(`${r.id}:entry`) ?? 0.5;

    if (Math.abs(colIndex.get(ps.col) - colIndex.get(pt.col)) > 1) {
      // top-lane routing for multi-column spans: leave the source from its top
      // edge, run horizontally through a dedicated lane just below the header
      // divider, then drop inside the gutter to the LEFT of the target column
      // and enter from the target's left side, so the polyline never crosses a
      // table card or the straight inter-column edges lower down.
      const y = busY.get(r.id);
      const exitFrac = 0.3 + 0.4 * fExit;
      const sx = ps.x + ps.w * exitFrac;
      const laneX = colX.get(finalColIds[colIndex.get(pt.col)]) - GUTTER_X / 2;
      const entryFrac = 0.18 + fEntry * 0.64;
      const ty = pt.y + pt.h * entryFrac;
      pushEdge(
        r,
        `${edgeStyleBase(r)}exitX=${exitFrac.toFixed(3)};exitY=0;exitDx=0;exitDy=0;entryX=0;entryY=${entryFrac.toFixed(3)};entryDx=0;entryDy=0;`,
        [
          { x: sx, y },
          { x: laneX, y },
          { x: laneX, y: ty },
        ]
      );
    } else {
      // left-to-right straight connector with distributed ports
      const exitYFrac = 0.18 + fExit * 0.64;
      const entryYFrac = 0.18 + fEntry * 0.64;
      pushEdge(
        r,
        `${edgeStyleBase(r)}exitX=1;exitY=${exitYFrac.toFixed(3)};exitDx=0;exitDy=0;entryX=0;entryY=${entryYFrac.toFixed(3)};entryDx=0;entryDy=0;`
      );
    }
  }

  // self relations: loop on the left side of the card
  for (const r of selfRels) {
    const p = posOf.get(r.from);
    if (!p) continue;
    const lx = p.x - 30;
    const y1 = p.y + Math.max(HEADER_H + 10, p.h * 0.3);
    const y2 = p.y + Math.min(p.h - 14, p.h * 0.75);
    pushEdge(
      r,
      `${edgeStyleBase(r)}exitX=0;exitY=${((y1 - p.y) / p.h).toFixed(3)};exitDx=0;exitDy=0;entryX=0;entryY=${((y2 - p.y) / p.h).toFixed(3)};entryDx=0;entryDy=0;labelBackgroundColor=#FFFFFF;`,
      [
        { x: lx, y: y1 },
        { x: lx, y: y2 },
      ]
    );
  }

  // 5. footer
  const footerText = `${tables.length} tables · ${relations.length} relations${spec.sources?.length ? ` · source: ${spec.sources.join(", ")}` : ""}`;
  lines.push(
    `        <mxCell id="${escapeXml(fx("footer"))}" value="${escapeXml(footerText)}" style="text;html=1;align=left;verticalAlign=middle;fontSize=10;fontColor=${COLOR.footer};" vertex="1" parent="1">`
  );
  lines.push(
    `          <mxGeometry x="${OUTER_PAD}" y="${diagramBottom}" width="600" height="20" as="geometry" />`
  );
  lines.push(`        </mxCell>`);

  lines.push(`      </root>`);
  lines.push(`    </mxGraphModel>`);
  lines.push(`  </diagram>`);
  lines.push(`</mxfile>`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP_TEXT = `
build-er.mjs - SQL DDL / Prisma / JSON spec -> Crow's Foot ER Diagram (.drawio + .drawio.png)

Usage:
  node scripts/build-er.mjs --schema <file-or-dir> [-o er.drawio.png] [options]
  node scripts/build-er.mjs --spec <er-spec.json>  [-o er.drawio.png] [options]

Options:
      --schema <path>   .sql / .prisma file or directory (repeatable via multiple args after --)
  -i, --spec <path>     Curated ER JSON spec (see references/spec-schema.md)
  -o, --output <path>   Output PNG or SVG path (default: er.drawio.png)
      --xml-out <path>  Output .drawio XML path (default: alongside output)
      --json-out <path> Save extracted JSON spec when using --schema
      --follow-symlinks Trace symbolic links inside scanned directories (off by default)
      --title <text>    Diagram title
      --subtitle <text> Diagram subtitle
  -s, --scale <number>  PNG scale factor (default: 2)
  -b, --border <px>     Border padding in pixels (default: 16)
      --theme <theme>   Color theme: light | dark (default: light)
  -h, --help            Show help
`.trim();

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      schema: { type: "string", multiple: true },
      spec: { type: "string", short: "i" },
      output: { type: "string", short: "o" },
      "xml-out": { type: "string" },
      "json-out": { type: "string" },
      "follow-symlinks": { type: "boolean", default: false },
      title: { type: "string" },
      subtitle: { type: "string" },
      scale: { type: "string", short: "s", default: "2" },
      border: { type: "string", short: "b", default: "16" },
      theme: { type: "string", default: "light" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  const schemaInputs = [...(values.schema || []), ...positionals];
  if (values.help || (!values.spec && schemaInputs.length === 0)) {
    console.log(HELP_TEXT);
    process.exit(values.help ? 0 : 1);
  }

  // --- 入力・出力の衝突検査（必ず「最初の書き込み」より前に行う） -----------
  // --json-out はスキャン直後に書き込まれるため、検査が後になると入力 SQL そのものへ
  // JSON を書き込んで原文を失う。ここでは 1 バイトも書き込まずに exit 1 する。
  // 照合には scan-schema と同じ走査関数（collectSchemaInputFiles）の一覧を使い、
  // `out/` などビルダー側の簡易走査が拾わないディレクトリも必ず対象に含める。
  const outPath = values.output || "er.drawio.png";
  const xmlOutPath =
    values["xml-out"] || outPath.replace(/\.drawio\.png$|\.png$|\.svg$/i, "") + ".drawio";
  const outputEntries = [
    { role: "--json-out", value: values["json-out"] },
    { role: "--xml-out", value: xmlOutPath },
    { role: "--output", value: outPath },
  ];
  const clashInputs = (scannedFiles) =>
    values.spec
      ? [{ role: "--spec", value: values.spec }]
      : [
          ...schemaInputs.map((p) => ({ role: "--schema", value: p })),
          { role: "--schema（スキャン対象）", files: scannedFiles },
        ];

  let plannedSchemaFiles = [];
  if (!values.spec) {
    plannedSchemaFiles = await collectSchemaInputFiles(schemaInputs, {
      followSymlinks: values["follow-symlinks"],
    });
    assertOutputsDistinctFromInputs({
      inputs: clashInputs(plannedSchemaFiles),
      outputs: outputEntries,
    });
  } else {
    assertOutputsDistinctFromInputs({ inputs: clashInputs([]), outputs: outputEntries });
  }

  const scannedSchemaFiles = [];
  let spec;
  if (values.spec) {
    spec = JSON.parse(await fs.readFile(values.spec, "utf8"));
    if (values.title) spec.title = values.title;
    if (values.subtitle) spec.subtitle = values.subtitle;
  } else {
    spec = await scanSchemaFiles(schemaInputs, {
      title: values.title,
      subtitle: values.subtitle,
      followSymlinks: values["follow-symlinks"],
      files: plannedSchemaFiles,
      scannedInputFiles: scannedSchemaFiles,
    });
    // 書き込み直前に、実際に走査した一覧でもう一度検査する
    assertOutputsDistinctFromInputs({
      inputs: clashInputs(scannedSchemaFiles),
      outputs: outputEntries,
    });
    if (values["json-out"]) {
      await fs.mkdir(path.dirname(resolveWriteTarget(values["json-out"])), { recursive: true });
      await writeFileAtomic(values["json-out"], JSON.stringify(spec, null, 2));
      console.log(`Generated JSON: ${values["json-out"]}`);
    }
  }

  const xml = generateErDrawioXml(spec);

  const scale = parseFloat(values.scale) || 2;
  const border = parseInt(values.border, 10) || 16;

  if (!values.spec) {
    // .drawio / 画像を書く直前にも同じ実走査一覧で再検査する
    assertOutputsDistinctFromInputs({
      inputs: clashInputs(scannedSchemaFiles),
      outputs: outputEntries,
    });
  }

  // 先にメモリ上で変換し、成功してから .drawio / 画像を書き出す
  // （変換失敗時に「新しい XML + 古い画像」の不整合を残さない）
  const { res, isSvg } = await emitDiagramFiles({
    xml,
    outPath,
    xmlOutPath,
    convertPng: convertXmlToPng,
    convertSvg: convertXmlToSvg,
    scale,
    border,
    theme: values.theme,
  });
  console.log(`Generated XML: ${xmlOutPath}`);
  console.log(`Generated ${isSvg ? "SVG" : "PNG"}: ${outPath} (${res.width}x${res.height}px)`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => {
    console.error("Error:", err.message || err);
    process.exit(1);
  });
}
