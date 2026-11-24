#!/usr/bin/env node
/**
 * build-sequence.mjs
 * Generates a polished UML Sequence Diagram (.drawio XML + .drawio.png / .svg)
 * from a JSON spec (`--spec`). Pure Node.js ESM, zero npm dependencies.
 * The generated PNG embeds the source draw.io XML (re-editable in draw.io).
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { convertXmlToPng, convertXmlToSvg } from "./drawio2png.mjs";
import { assertDistinctPaths, createCellIdMap, emitDiagramFiles, isDirectRun } from "./diagram-shared.mjs";

function escapeXml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Header / accent palette per participant kind. */
const KIND_STYLES = {
  actor: { fill: "#EFF6FF", stroke: "#2563EB", font: "#1E3A8A" },
  client: { fill: "#F0FDF4", stroke: "#16A34A", font: "#14532D" },
  service: { fill: "#F8FAFC", stroke: "#0F172A", font: "#0F172A" },
  database: { fill: "#EEF2FF", stroke: "#4F46E5", font: "#312E81" },
  queue: { fill: "#FDF2F8", stroke: "#DB2777", font: "#831843" },
  external: { fill: "#FFFBEB", stroke: "#D97706", font: "#78350F" },
};

/** Arrow styles per message type. */
const ARROW_STYLES = {
  sync: "endArrow=block;endFill=1;strokeColor=#1E293B;strokeWidth=1.5;",
  async:
    "endArrow=open;endFill=0;dashed=1;dashPattern=6 3;strokeColor=#0284C7;strokeWidth=1.6;",
  reply:
    "endArrow=open;endFill=0;dashed=1;dashPattern=5 3;strokeColor=#64748B;strokeWidth=1.4;",
  return:
    "endArrow=open;endFill=0;dashed=1;dashPattern=5 3;strokeColor=#64748B;strokeWidth=1.4;",
};
const LABEL_FONT_COLORS = {
  sync: "#0F172A",
  async: "#075985",
  reply: "#475569",
  return: "#475569",
};

/** Very light fill per fragment type (frame stroke is dashed slate). */
const FRAGMENT_FILLS = {
  alt: "#F8FAFC",
  opt: "#F0FDF4",
  loop: "#FFFBEB",
  par: "#EEF2FF",
  break: "#FEF2F2",
  critical: "#FFF1F2",
};

// ---------------------------------------------------------------------------
// Layout constants (generous whitespace, documentation-grade proportions)
// ---------------------------------------------------------------------------
const MARGIN = 28;
const TITLE_BAR_W = 5;
const TITLE_BLOCK_H = 44;
const SEP_GAP = 16; // gap between title block and separator line
const HEAD_GAP = 30; // gap between separator line and participant headers
const HEADER_W = 164;
const HEADER_H = 46;
const FIRST_ROW_GAP = 42; // header bottom -> first message arrow
const DEFAULT_ROW_H = 46;
const DEFAULT_SPACING = 220;
const ACT_W = 12;
const FOOTER_GAP = 26;
const SIDE_PAD = 118; // canvas padding on the left of the 1st / right of the last lifeline

const HEADER_STYLE =
  "rounded=1;arcSize=12;html=1;whiteSpace=wrap;shadow=0;strokeWidth=1.2;" +
  "fontSize=11;fontStyle=1;align=center;verticalAlign=middle;spacing=4;";
const LIFELINE_STYLE =
  "edgeStyle=none;html=1;rounded=0;startArrow=none;endArrow=none;" +
  "strokeColor=#94A3B8;strokeWidth=1;dashed=1;dashPattern=5 4;";
const ACTIVATION_STYLE =
  "html=1;shadow=0;fillColor=#FFFFFF;strokeColor=#475569;strokeWidth=1.2;";
const NOTE_STYLE =
  "rounded=1;arcSize=12;html=1;whiteSpace=wrap;shadow=0;" +
  "fillColor=#FFFBEB;strokeColor=#F59E0B;strokeWidth=1;" +
  "fontSize=9.5;fontColor=#92400E;align=left;verticalAlign=middle;spacing=7;";
const FRAGMENT_STYLE_BASE =
  "html=1;shadow=0;rounded=0;verticalAlign=top;align=left;spacingLeft=52;spacingTop=1;" +
  "fontSize=10;fontStyle=2;fontColor=#475569;dashed=1;dashPattern=6 4;strokeWidth=1;" +
  "labelBackgroundColor=#FFFFFF;";
const FRAGMENT_BADGE_STYLE =
  "html=1;shadow=0;rounded=0;fillColor=#F1F5F9;strokeColor=#64748B;strokeWidth=1;" +
  "fontSize=9;fontStyle=1;fontColor=#334155;align=center;verticalAlign=middle;";
const TEXT_LABEL_STYLE =
  "text;html=1;align=left;verticalAlign=middle;overflow=visible;spacing=1;" +
  "fontSize=10.5;fontColor=#0F172A;labelBackgroundColor=#FFFFFF;";

/**
 * Generates the draw.io `<mxfile>` XML for a UML sequence diagram spec.
 *
 * Spec shape (all fields except participants/messages are optional):
 * {
 *   title, subtitle, autonumber, spacing, rowHeight, legend,
 *   participants: [{ id, name, sub, kind }],
 *   messages:     [{ from, to, label, type, activate, gap }],
 *   activations:  [{ participant, fromStep, toStep }],
 *   fragments:    [{ type, label, fromStep, toStep, elseAtStep, elseLabel,
 *                    fromParticipant, toParticipant }],
 *   notes:        [{ text, atStep, participant, spanTo, dy, width, height }]
 * }
 */
export function generateSequenceDrawioXml(spec) {
  const title = spec.title || "UML シーケンス図";
  const subtitle = spec.subtitle || "";
  const showLegend = spec.legend !== false;
  const autonumber = spec.autonumber === true;
  const spacing = Number(spec.spacing) || DEFAULT_SPACING;
  const rowH = Number(spec.rowHeight) || DEFAULT_ROW_H;

  const participants = Array.isArray(spec.participants) ? spec.participants : [];
  const messages = Array.isArray(spec.messages) ? spec.messages : [];
  if (participants.length === 0) {
    throw new Error("spec.participants に 1 つ以上の参加者が必要です");
  }

  const kindOf = (p) => KIND_STYLES[p.kind] || KIND_STYLES.service;
  const pIndex = new Map();
  participants.forEach((p, i) => pIndex.set(String(p.id), i));
  const xOf = (id) => {
    const idx = pIndex.get(String(id));
    if (idx == null) throw new Error(`未定義の参加者 ID が参照されています: ${id}`);
    return MARGIN + SIDE_PAD + idx * spacing;
  };

  // --- vertical layout -------------------------------------------------
  const titleTop = MARGIN + 2;
  const sepY = titleTop + TITLE_BLOCK_H + SEP_GAP;
  const headTop = sepY + HEAD_GAP;
  const headBottom = headTop + HEADER_H;
  const firstRowY = headBottom + FIRST_ROW_GAP;

  const rowY = [];
  {
    let y = firstRowY;
    for (const m of messages) {
      rowY.push(y);
      y += rowH + (Number(m.gap) || 0);
    }
  }
  const lastRowY = rowY.length > 0 ? rowY[rowY.length - 1] : headBottom + FIRST_ROW_GAP;

  // メッセージ 0 件でも（断片やノートだけで描くことがあるため）行番号を安全に y へ変換する。
  // 生の rowY[i] を参照すると空配列のときに undefined 演算で NaN が混入する。
  const rowYAt = (i) => {
    if (rowY.length === 0) return firstRowY;
    const idx = Math.min(Math.max(Number(i) || 0, 0), rowY.length - 1);
    return rowY[idx];
  };

  // --- activations (explicit list + `activate: true` auto-detection) ----
  // Stored 0-indexed by message row: { participant, fromRow, toRow }.
  const activations = [];
  for (const a of Array.isArray(spec.activations) ? spec.activations : []) {
    const fromRow = Math.max(0, (Number(a.fromStep) || 1) - 1);
    const toRow = Math.min(
      Math.max(messages.length - 1, 0),
      Math.max(fromRow, (Number(a.toStep) || a.fromStep || 1) - 1)
    );
    activations.push({ participant: String(a.participant), fromRow, toRow });
  }
  messages.forEach((m, i) => {
    if (!m.activate || m.type === "reply" || m.type === "return") return;
    const src = String(m.from);
    const dst = String(m.to);
    let endRow = messages.length - 1;
    for (let j = i + 1; j < messages.length; j++) {
      const r = messages[j];
      if (
        (r.type === "reply" || r.type === "return") &&
        String(r.from) === dst &&
        String(r.to) === src
      ) {
        endRow = j;
        break;
      }
    }
    activations.push({ participant: dst, fromRow: i, toRow: endRow });
  });
  const activationAt = (pid, y) =>
    activations.some((a) => {
      if (String(a.participant) !== String(pid)) return false;
      const y1 = rowYAt(a.fromRow) - 4;
      const y2 = rowYAt(a.toRow) + 4;
      return y >= y1 && y <= y2;
    });

  // --- canvas extents ----------------------------------------------------
  const n = participants.length;
  const lastX = MARGIN + SIDE_PAD + (n - 1) * spacing;
  const hasSelfRight = messages.some(
    (m) =>
      String(m.from) === String(m.to) &&
      pIndex.get(String(m.from)) === n - 1
  );
  const rightPad = SIDE_PAD + (hasSelfRight ? 210 : 0);
  const canvasW = lastX + rightPad + MARGIN;

  let contentBottom = lastRowY + 18;
  for (const a of activations) contentBottom = Math.max(contentBottom, rowYAt(a.toRow) + 6);
  for (const fr of Array.isArray(spec.fragments) ? spec.fragments : []) {
    const toRow = Math.min(messages.length - 1, (Number(fr.toStep) || 1) - 1);
    contentBottom = Math.max(contentBottom, rowYAt(toRow) + 22);
  }
  for (const nt of Array.isArray(spec.notes) ? spec.notes : []) {
    const at = Math.min(messages.length, Number(nt.atStep) || 1);
    const ny = rowYAt(at - 1) + (Number(nt.dy) || 14);
    contentBottom = Math.max(contentBottom, ny + (Number(nt.height) || 40));
  }
  const footerTop = Math.max(contentBottom + FOOTER_GAP, lastRowY + 34);
  const canvasH = footerTop + HEADER_H + MARGIN;

  const xmlLines = [];
  // 単一の ID アロケーターで固定セル・ヘッダー・ライフライン・メッセージ・
  // フラグメント・ノートの全 mxCell ID を採番する（衝突時は連番で避ける）。
  const ids = createCellIdMap();
  const cid = (raw) => ids.fixed(String(raw));
  xmlLines.push(`<mxfile host="drawio-sequence-skill" version="1.0.0">`);
  xmlLines.push(
    `  <diagram id="sequence-1" name="${escapeXml(title)}">`
  );
  xmlLines.push(
    `    <mxGraphModel dx="1400" dy="900" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${canvasW}" pageHeight="${canvasH}" background="#FFFFFF" shadow="0">`
  );
  xmlLines.push(`      <root>`);
  xmlLines.push(`        <mxCell id="0" />`);
  xmlLines.push(`        <mxCell id="1" parent="0" />`);

  const vertex = (rawId, value, style, x, y, w, h) => {
    const id = cid(rawId);
    xmlLines.push(
      `        <mxCell id="${escapeXml(id)}" value="${escapeXml(value)}" style="${escapeXml(style)}" vertex="1" parent="1">`
    );
    xmlLines.push(
      `          <mxGeometry x="${Math.round(x)}" y="${Math.round(y)}" width="${Math.round(w)}" height="${Math.round(h)}" as="geometry" />`
    );
    xmlLines.push(`        </mxCell>`);
  };
  const floatEdge = (rawId, value, style, src, dst, points = []) => {
    const id = cid(rawId);
    xmlLines.push(
      `        <mxCell id="${escapeXml(id)}" value="${escapeXml(value)}" style="${escapeXml(style)}" edge="1" parent="1">`
    );
    xmlLines.push(`          <mxGeometry relative="1" as="geometry">`);
    xmlLines.push(
      `            <mxPoint x="${Math.round(src.x)}" y="${Math.round(src.y)}" as="sourcePoint" />`
    );
    if (points.length > 0) {
      xmlLines.push(`            <Array as="points">`);
      for (const pt of points) {
        xmlLines.push(
          `              <mxPoint x="${Math.round(pt.x)}" y="${Math.round(pt.y)}" />`
        );
      }
      xmlLines.push(`            </Array>`);
    }
    xmlLines.push(
      `            <mxPoint x="${Math.round(dst.x)}" y="${Math.round(dst.y)}" as="targetPoint" />`
    );
    xmlLines.push(`          </mxGeometry>`);
    xmlLines.push(`        </mxCell>`);
  };

  // =======================================================================
  // 1. Header band: accent bar + left-aligned title / subtitle + separator
  // =======================================================================
  vertex(
    "title_accent",
    "",
    "rounded=0;html=1;shadow=0;fillColor=#0284C7;strokeColor=none;",
    MARGIN,
    titleTop + 2,
    TITLE_BAR_W,
    TITLE_BLOCK_H - 6
  );
  xmlLines.push(
    `        <mxCell id="${escapeXml(cid("title_text"))}" value="${escapeXml(title)}" style="text;html=1;align=left;verticalAlign=top;fontSize=18;fontStyle=1;fontColor=#0F172A;" vertex="1" parent="1">`
  );
  xmlLines.push(
    `          <mxGeometry x="${MARGIN + TITLE_BAR_W + 12}" y="${titleTop}" width="${Math.round(canvasW * 0.55)}" height="24" as="geometry" />`
  );
  xmlLines.push(`        </mxCell>`);
  if (subtitle) {
    xmlLines.push(
      `        <mxCell id="${escapeXml(cid("subtitle_text"))}" value="${escapeXml(subtitle)}" style="text;html=1;align=left;verticalAlign=top;fontSize=11;fontColor=#475569;" vertex="1" parent="1">`
    );
    xmlLines.push(
      `          <mxGeometry x="${MARGIN + TITLE_BAR_W + 13}" y="${titleTop + 25}" width="${Math.round(canvasW * 0.55)}" height="16" as="geometry" />`
    );
    xmlLines.push(`        </mxCell>`);
  }
  floatEdge(
    "header_sep",
    "",
    "edgeStyle=none;html=1;startArrow=none;endArrow=none;strokeColor=#E2E8F0;strokeWidth=1;",
    { x: MARGIN, y: sepY },
    { x: canvasW - MARGIN, y: sepY }
  );

  // =======================================================================
  // 2. Legend (top-right, compact)
  // =======================================================================
  if (showLegend) {
    const LEG_W = 212;
    const LEG_H = 94;
    const legX = canvasW - MARGIN - LEG_W;
    const legY = titleTop - 8;
    vertex(
      "legend_box",
      "",
      "rounded=1;arcSize=12;html=1;shadow=0;fillColor=#FFFFFF;strokeColor=#E2E8F0;strokeWidth=1;",
      legX,
      legY,
      LEG_W,
      LEG_H
    );
    xmlLines.push(
      `        <mxCell id="${escapeXml(cid("legend_title"))}" value="LEGEND" style="text;html=1;align=left;verticalAlign=middle;fontSize=8;fontStyle=1;fontColor=#64748B;" vertex="1" parent="1">`
    );
    xmlLines.push(
      `          <mxGeometry x="${legX + 12}" y="${legY + 6}" width="90" height="14" as="geometry" />`
    );
    xmlLines.push(`        </mxCell>`);
    const legendRows = [
      { id: "sync", label: "Sync call", style: ARROW_STYLES.sync },
      { id: "async", label: "Async message", style: ARROW_STYLES.async },
      { id: "reply", label: "Return / reply", style: ARROW_STYLES.reply },
    ];
    legendRows.forEach((row, i) => {
      const ry = legY + 34 + i * 22;
      floatEdge(
        `legend_${row.id}`,
        "",
        `edgeStyle=none;html=1;${row.style}`,
        { x: legX + 14, y: ry },
        { x: legX + 52, y: ry }
      );
      xmlLines.push(
        `        <mxCell id="${escapeXml(cid(`legend_${row.id}_label`))}" value="${escapeXml(row.label)}" style="text;html=1;align=left;verticalAlign=middle;fontSize=9.5;fontColor=#334155;" vertex="1" parent="1">`
      );
      xmlLines.push(
        `          <mxGeometry x="${legX + 62}" y="${ry - 8}" width="${LEG_W - 74}" height="16" as="geometry" />`
      );
      xmlLines.push(`        </mxCell>`);
    });
  }

  // =======================================================================
  // 3. Fragments (BACKGROUND layer — emitted before arrows/labels)
  // =======================================================================
  const fragments = Array.isArray(spec.fragments) ? spec.fragments : [];
  const fragmentCondCells = []; // rendered above messages/activations (z-order)
  fragments.forEach((fr, fi) => {
    const type = String(fr.type || "alt").toLowerCase();
    const fill = FRAGMENT_FILLS[type] || FRAGMENT_FILLS.alt;
    const fromRow = Math.max(0, (Number(fr.fromStep) || 1) - 1);
    const toRow = Math.min(messages.length - 1, Math.max(fromRow, (Number(fr.toStep) || 1) - 1));
    const iFrom =
      fr.fromParticipant != null ? pIndex.get(String(fr.fromParticipant)) : 0;
    const iTo = fr.toParticipant != null ? pIndex.get(String(fr.toParticipant)) : n - 1;
    if (iFrom == null || iTo == null) {
      throw new Error(`フラグメント #${fi + 1} の参加者 ID が未定義です`);
    }
    const pad = 55;
    const fx = Math.max(MARGIN, MARGIN + SIDE_PAD + Math.min(iFrom, iTo) * spacing - pad);
    const fx2 = Math.min(
      canvasW - MARGIN,
      MARGIN + SIDE_PAD + Math.max(iFrom, iTo) * spacing + pad
    );
    const fy = rowYAt(fromRow) - 40;
    const fy2 = rowYAt(toRow) + 22;
    const condition = fr.label ? `[${fr.label}]` : "";

    vertex(
      `frag_${fi}`,
      "",
      `${FRAGMENT_STYLE_BASE}fillColor=${fill};strokeColor=#64748B;`,
      fx,
      fy,
      fx2 - fx,
      fy2 - fy
    );
    const badgeW = Math.max(36, type.length * 7 + 16);
    vertex(
      `frag_${fi}_badge`,
      type,
      FRAGMENT_BADGE_STYLE,
      fx,
      fy,
      badgeW,
      18
    );

    const condLines = [];
    const condVertex = (rawId, value, style, x, y, w, h) => {
      const id = cid(rawId);
      condLines.push(
        `        <mxCell id="${escapeXml(id)}" value="${escapeXml(value)}" style="${escapeXml(style)}" vertex="1" parent="1">`
      );
      condLines.push(
        `          <mxGeometry x="${Math.round(x)}" y="${Math.round(y)}" width="${Math.round(w)}" height="${Math.round(h)}" as="geometry" />`
      );
      condLines.push(`        </mxCell>`);
    };
    if (condition) {
      // The condition text is emitted AFTER messages (see below) so the
      // activation bars and lifelines never cover it; white background keeps it readable.
      const condW = Math.max(140, condition.length * 11 + 8);
      condVertex(
        `frag_${fi}_cond`,
        condition,
        "text;html=1;align=left;verticalAlign=middle;overflow=visible;fontSize=10;fontStyle=2;fontColor=#475569;labelBackgroundColor=#FFFFFF;spacing=2;",
        fx + badgeW + 8,
        fy,
        condW,
        18
      );
    }
    fragmentCondCells.push(...condLines);

    if (type === "alt" && fr.elseAtStep != null) {
      const elseRow = Number(fr.elseAtStep) - 1;
      if (elseRow > fromRow && elseRow <= toRow) {
        const divY =
          elseRow - 1 >= 0 && elseRow - 1 < rowY.length
            ? (rowYAt(elseRow - 1) + rowYAt(elseRow)) / 2
            : rowYAt(elseRow) - rowH / 2;
        floatEdge(
          `frag_${fi}_else`,
          fr.elseLabel || "else",
          "edgeStyle=none;html=1;startArrow=none;endArrow=none;dashed=1;dashPattern=5 3;strokeColor=#94A3B8;strokeWidth=1;fontSize=9.5;fontStyle=2;fontColor=#475569;labelBackgroundColor=#FFFFFF;align=left;verticalAlign=bottom;spacing=4;",
          { x: fx + 1, y: divY },
          { x: fx2 - 1, y: divY }
        );
      }
    }
  });

  // =======================================================================
  // 4. Lifelines
  // =======================================================================
  participants.forEach((p, i) => {
    const x = MARGIN + SIDE_PAD + i * spacing;
    floatEdge(
      `lifeline_${i}`,
      "",
      LIFELINE_STYLE,
      { x, y: headBottom },
      { x, y: footerTop }
    );
  });

  // =======================================================================
  // 5. Participant headers (top) + footers (bottom, mirrored)
  // =======================================================================
  const headerValue = (p) => {
    const name = escapeXml(p.name || p.id);
    if (!p.sub) return name;
    return `${name}<br><font style="font-size:9px;font-weight:normal" color="#64748B">${escapeXml(p.sub)}</font>`;
  };
  participants.forEach((p, i) => {
    const ks = kindOf(p);
    const x = MARGIN + SIDE_PAD + i * spacing - HEADER_W / 2;
    const value = headerValue(p);
    vertex(
      `header_${i}`,
      value,
      `${HEADER_STYLE}fillColor=${ks.fill};strokeColor=${ks.stroke};fontColor=${ks.font};`,
      x,
      headTop,
      HEADER_W,
      HEADER_H
    );
    vertex(
      `footer_${i}`,
      value,
      `${HEADER_STYLE}fillColor=${ks.fill};strokeColor=${ks.stroke};fontColor=${ks.font};`,
      x,
      footerTop,
      HEADER_W,
      HEADER_H
    );
  });

  // =======================================================================
  // 6. Activation bars
  // =======================================================================
  activations.forEach((a, ai) => {
    const idx = pIndex.get(String(a.participant));
    if (idx == null) throw new Error(`activations の参加者 ID が未定義です: ${a.participant}`);
    const x = MARGIN + SIDE_PAD + idx * spacing;
    const y1 = rowYAt(a.fromRow) - 2;
    const y2 =
      a.toRow === a.fromRow
        ? y1 + 16
        : rowYAt(a.toRow) +
          (messages[a.toRow]?.type === "reply" || messages[a.toRow]?.type === "return" ? -2 : 4);
    vertex(
      `act_${ai}`,
      "",
      ACTIVATION_STYLE,
      x - ACT_W / 2,
      y1,
      ACT_W,
      Math.max(12, y2 - y1)
    );
  });

  // =======================================================================
  // 7. Messages (arrows + labels)
  // =======================================================================
  messages.forEach((m, i) => {
    const rawType = String(m.type || "sync").toLowerCase();
    const type = rawType === "return" ? "reply" : rawType;
    const arrowStyle = ARROW_STYLES[type] || ARROW_STYLES.sync;
    const fontColor = LABEL_FONT_COLORS[type] || "#0F172A";
    const labelBase =
      `html=1;labelBackgroundColor=#FFFFFF;fontSize=10.5;fontColor=${fontColor};` +
      "verticalAlign=bottom;spacingBottom=4;align=center;";
    const label = autonumber ? `${i + 1}. ${m.label || ""}` : m.label || "";
    const y = rowY[i];
    const srcId = String(m.from);
    const dstId = String(m.to);

    if (srcId === dstId) {
      // Self message: neat loop on the right side of the lifeline.
      const x = xOf(srcId);
      const sx = activationAt(srcId, y) ? x + ACT_W / 2 : x;
      const loopW = 38;
      const loopH = 20;
      floatEdge(
        `msg_${i}`,
        "",
        `edgeStyle=none;rounded=1;${arrowStyle}${labelBase}noLabel=1;`,
        { x: sx, y },
        { x: activationAt(srcId, y + loopH) ? x + ACT_W / 2 : x, y: y + loopH },
        [{ x: sx + loopW, y }, { x: sx + loopW, y: y + loopH }]
      );
      vertex(
        `msg_${i}_label`,
        label,
        TEXT_LABEL_STYLE,
        sx + loopW + 8,
        y + loopH / 2 - 8,
        200,
        16
      );
      return;
    }

    const sx0 = xOf(srcId);
    const tx0 = xOf(dstId);
    const rightward = tx0 > sx0;
    const sx = activationAt(srcId, y) ? sx0 + (rightward ? ACT_W / 2 : -ACT_W / 2) : sx0;
    const tx = activationAt(dstId, y) ? tx0 + (rightward ? -ACT_W / 2 : ACT_W / 2) : tx0;

    floatEdge(
      `msg_${i}`,
      label,
      `edgeStyle=none;rounded=0;${arrowStyle}${labelBase}endSize=6;`,
      { x: sx, y },
      { x: tx, y }
    );
  });

  // =======================================================================
  // 7.5. Fragment condition labels (above messages for readability)
  // =======================================================================
  xmlLines.push(...fragmentCondCells);

  // =======================================================================
  // 8. Notes (topmost layer)
  // =======================================================================
  const notes = Array.isArray(spec.notes) ? spec.notes : [];
  notes.forEach((nt, ni) => {
    const at = Math.min(messages.length, Math.max(1, Number(nt.atStep) || 1));
    const baseY = rowYAt(at - 1) + (Number(nt.dy) || 14);
    let nx;
    let nw;
    if (nt.spanTo != null) {
      const x1 = xOf(nt.participant ?? participants[0].id);
      const x2 = xOf(nt.spanTo);
      nx = Math.min(x1, x2) + 18;
      nw = Math.abs(x2 - x1) - 36;
    } else {
      const x = xOf(nt.participant ?? participants[0].id);
      nw = Number(nt.width) || 172;
      nx = nt.participant === participants[n - 1].id ? x - 18 - nw : x + 18;
    }
    vertex(
      `note_${ni}`,
      nt.text || "",
      NOTE_STYLE,
      nx,
      baseY,
      nw,
      Number(nt.height) || 40
    );
  });

  xmlLines.push(`      </root>`);
  xmlLines.push(`    </mxGraphModel>`);
  xmlLines.push(`  </diagram>`);
  xmlLines.push(`</mxfile>`);

  return xmlLines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const HELP_TEXT = `
build-sequence.mjs - JSON spec -> UML Sequence Diagram (.drawio + .drawio.png) Generator

Usage:
  node scripts/build-sequence.mjs --spec <sequence.json> [-o sequence.drawio.png] [options]

Options:
  -i, --spec <path>       Sequence diagram JSON spec file (required)
  -o, --output <path>     Output PNG or SVG file path (default: sequence.drawio.png)
      --xml-out <path>    Output .drawio XML file path
      --title <text>      Override diagram title
      --subtitle <text>   Override diagram subtitle
  -s, --scale <number>    PNG scale factor (default: 2)
  -b, --border <px>       Border padding in pixels (default: 16)
      --theme <theme>     Color theme: light | dark (default: light)
  -h, --help              Show help
`.trim();

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      spec: { type: "string", short: "i" },
      output: { type: "string", short: "o" },
      "xml-out": { type: "string" },
      title: { type: "string" },
      subtitle: { type: "string" },
      scale: { type: "string", short: "s", default: "2" },
      border: { type: "string", short: "b", default: "16" },
      theme: { type: "string", default: "light" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help || (!values.spec && positionals.length === 0)) {
    console.log(HELP_TEXT);
    process.exit(values.help ? 0 : 1);
  }

  const specPath = values.spec || positionals[0];
  const spec = JSON.parse(await fs.readFile(specPath, "utf8"));
  if (values.title) spec.title = values.title;
  if (values.subtitle) spec.subtitle = values.subtitle;

  const xml = generateSequenceDrawioXml(spec);
  const outPath = values.output || "sequence.drawio.png";
  const xmlOutPath =
    values["xml-out"] ||
    outPath.replace(/\.drawio\.png$|\.png$|\.svg$/i, "") + ".drawio";

  // 入力 (--spec) と --xml-out / --output が正規化後に同一パスなら先行エラーで止める
  assertDistinctPaths([
    { role: "--spec", value: specPath },
    { role: "--xml-out", value: xmlOutPath },
    { role: "--output", value: outPath },
  ]);

  const scale = parseFloat(values.scale) || 2;
  const border = parseInt(values.border, 10) || 16;

  // 先にメモリ上で変換し、成功してから .drawio / 画像を書き出す
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
