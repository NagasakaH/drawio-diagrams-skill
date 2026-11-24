#!/usr/bin/env node
/**
 * build-aws-arch.mjs
 * Generates a clean, AWS-official-style Architecture Diagram (.drawio XML + .drawio.png)
 * from either a Terraform directory (`--tf-dir`) or a curated JSON spec (`--spec`).
 * Uses official AWS4 icons (`mxgraph.aws4.*`) and embeds the draw.io XML into the PNG.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { convertXmlToPng, convertXmlToSvg } from "./drawio2png.mjs";
import { scanTerraformDirectory } from "./scan-terraform.mjs";
import {
  assertOutputsDistinctFromInputs,
  createCellIdMap,
  emitDiagramFiles,
  expandInputPaths,
  isDirectRun,
} from "./diagram-shared.mjs";

function escapeXml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const LAYER_CONFIG = [
  {
    id: "edge",
    title: "EDGE / API",
    accentColor: "#8C4FFF",
    fillColor: "#FAFAFC",
    borderColor: "#D8DCE3",
  },
  {
    id: "compute",
    title: "COMPUTE & ORCHESTRATION",
    accentColor: "#ED7100",
    fillColor: "#FFFDF9",
    borderColor: "#E6DFD5",
  },
  {
    id: "messaging",
    title: "MESSAGING / EVENTS",
    accentColor: "#E7157B",
    fillColor: "#FFFAFC",
    borderColor: "#E8D8E0",
  },
  {
    id: "storage",
    title: "DATA & STORAGE",
    accentColor: "#2E7D32",
    fillColor: "#F9FCFA",
    borderColor: "#D5E3D8",
  },
  {
    id: "security",
    title: "SECURITY (OPTIONAL)",
    accentColor: "#DD344C",
    fillColor: "#FFFAFA",
    borderColor: "#E8D5D8",
  },
  {
    id: "network",
    title: "NETWORK (OPTIONAL)",
    accentColor: "#248814",
    fillColor: "#F9FCF9",
    borderColor: "#D5E3D5",
  },
  {
    id: "iam",
    title: "IAM (OPTIONAL)",
    accentColor: "#DD344C",
    fillColor: "#FFFAFA",
    borderColor: "#E8D5D8",
  },
  {
    id: "observability",
    title: "OBSERVABILITY (OPTIONAL)",
    accentColor: "#E7157B",
    fillColor: "#FFFAFC",
    borderColor: "#E8D8E0",
  },
];

const ICON_SIZE = 52;
const BASE_ICON_STYLE =
  "outlineConnect=0;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;shape=mxgraph.aws4.resourceIcon;strokeColor=#ffffff;labelBackgroundColor=none;spacingTop=4;";

const AWS_KIND_STYLES = {
  // External actor
  users: {
    width: 44,
    height: 44,
    isIcon: true,
    style:
      "outlineConnect=0;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;shape=mxgraph.aws4.users;fillColor=#232F3E;strokeColor=none;spacingTop=4;",
  },

  // Edge
  cloudfront: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.cloudfront;fillColor=#8C4FFF;`,
  },
  apigw: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.api_gateway;fillColor=#E7157B;`,
  },
  alb: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.application_load_balancer;fillColor=#8C4FFF;`,
  },
  cognito: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.cognito;fillColor=#DD344C;`,
  },
  eventbridge: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.eventbridge;fillColor=#E7157B;`,
  },

  // Compute & Orchestration
  lambda: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.lambda;fillColor=#ED7100;`,
  },
  sfn: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.step_functions;fillColor=#E7157B;`,
  },
  ecs: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.ecs;fillColor=#ED7100;`,
  },
  eks: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.eks;fillColor=#ED7100;`,
  },
  ec2: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.ec2;fillColor=#ED7100;`,
  },

  // Messaging
  sqs: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.sqs;fillColor=#E7157B;`,
  },
  sns: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.sns;fillColor=#E7157B;`,
  },
  kinesis: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.kinesis;fillColor=#8C4FFF;`,
  },
  firehose: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.kinesis_data_firehose;fillColor=#8C4FFF;`,
  },

  // Storage & Database
  aurora: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.aurora;fillColor=#3B48CC;`,
  },
  rds: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.rds;fillColor=#3B48CC;`,
  },
  dynamodb: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.dynamodb;fillColor=#3B48CC;`,
  },
  s3: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.s3;fillColor=#3F8624;`,
  },
  elasticache: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.elasticache;fillColor=#3B48CC;`,
  },
  efs: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.efs_standard;fillColor=#3F8624;`,
  },
  opensearch: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.opensearch_service_data_node;fillColor=#8C4FFF;`,
  },

  // Optional: Security / Network / IAM / Observability
  sg: {
    width: 156,
    height: 52,
    isIcon: false,
    style:
      "rounded=1;arcSize=12;whiteSpace=wrap;html=1;dashed=1;dashPattern=5 3;fillColor=#FFF8F8;strokeColor=#DD344C;strokeWidth=1.4;",
  },
  waf: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    isIcon: true,
    style: `${BASE_ICON_STYLE}resIcon=mxgraph.aws4.waf;fillColor=#DD344C;`,
  },
  kms: {
    width: 156,
    height: 50,
    isIcon: false,
    style:
      "rounded=1;arcSize=12;whiteSpace=wrap;html=1;fillColor=#FFF8F8;strokeColor=#DD344C;strokeWidth=1.2;",
  },
  secrets: {
    width: 156,
    height: 50,
    isIcon: false,
    style:
      "rounded=1;arcSize=12;whiteSpace=wrap;html=1;fillColor=#FFF8F8;strokeColor=#DD344C;strokeWidth=1.2;",
  },
  vpc: {
    width: 156,
    height: 50,
    isIcon: false,
    style:
      "rounded=1;arcSize=12;whiteSpace=wrap;html=1;fillColor=#F4FAF3;strokeColor=#248814;strokeWidth=1.4;",
  },
  subnet: {
    width: 156,
    height: 48,
    isIcon: false,
    style:
      "rounded=1;arcSize=12;whiteSpace=wrap;html=1;dashed=1;fillColor=#F3F8FD;strokeColor=#0073BB;strokeWidth=1.2;",
  },
  nat: {
    width: 156,
    height: 48,
    isIcon: false,
    style:
      "rounded=1;arcSize=12;whiteSpace=wrap;html=1;fillColor=#F8F5FF;strokeColor=#8C4FFF;strokeWidth=1.2;",
  },
  igw: {
    width: 156,
    height: 48,
    isIcon: false,
    style:
      "rounded=1;arcSize=12;whiteSpace=wrap;html=1;fillColor=#F8F5FF;strokeColor=#8C4FFF;strokeWidth=1.2;",
  },
  vpce: {
    width: 156,
    height: 48,
    isIcon: false,
    style:
      "rounded=1;arcSize=12;whiteSpace=wrap;html=1;fillColor=#F8F5FF;strokeColor=#8C4FFF;strokeWidth=1.2;",
  },
  iam: {
    width: 156,
    height: 48,
    isIcon: false,
    style:
      "rounded=1;arcSize=12;whiteSpace=wrap;html=1;fillColor=#FFF8F8;strokeColor=#DD344C;strokeWidth=1.2;",
  },
  cloudwatch: {
    width: 156,
    height: 48,
    isIcon: false,
    style:
      "rounded=1;arcSize=12;whiteSpace=wrap;html=1;fillColor=#FFF5FA;strokeColor=#E7157B;strokeWidth=1.2;",
  },
};

const EDGE_BASE =
  "edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endSize=6;fontSize=10;fontColor=#232F3E;labelBackgroundColor=#FFFFFF;labelBorderColor=none;";

const EDGE_STYLES = {
  flow: `${EDGE_BASE}endArrow=block;endFill=1;strokeWidth=1.6;strokeColor=#232F3E;`,
  data: `${EDGE_BASE}endArrow=block;endFill=1;strokeWidth=1.6;strokeColor=#0073BB;`,
  async: `${EDGE_BASE}dashed=1;dashPattern=5 3;endArrow=block;endFill=1;strokeWidth=1.6;strokeColor=#D91B7A;`,
  security: `${EDGE_BASE}dashed=1;dashPattern=3 3;endArrow=open;strokeWidth=1.3;strokeColor=#DD344C;fontColor=#B42318;`,
  network: `${EDGE_BASE}dashed=1;dashPattern=3 3;endArrow=open;strokeWidth=1.3;strokeColor=#248814;fontColor=#1D6B10;`,
  // 静的参照（環境変数・属性の参照だけから推定した線）。実行の証拠はないため控えめに描く。
  reference: `${EDGE_BASE}dashed=1;dashPattern=2 4;endArrow=open;strokeWidth=1.1;strokeColor=#8791A0;fontColor=#545B64;`,
};

const EXTERNAL_ENTRY_KINDS = new Set(["cloudfront", "apigw", "alb", "cognito"]);

/**
 * Formats a concise, AWS-official-style 2-line label:
 * Line 1: Bold resource name (#232F3E)
 * Line 2: Service name + concise detail (#545B64)
 */
function formatResourceLabel(node) {
  const name = String(node.label || node.tfName || node.id);
  const lines = [`<b style="font-size:11px;color:#232F3E">${escapeXml(name)}</b>`];

  const svc = node.serviceLabel ? String(node.serviceLabel) : "";
  let detail = node.subtitle ? String(node.subtitle) : "";
  // Strip redundant resource name prefix from subtitle (e.g. "order-api-handler / nodejs22.x" -> "nodejs22.x")
  if (detail && detail.toLowerCase().startsWith(name.toLowerCase())) {
    detail = detail.slice(name.length).replace(/^\s*[/·-]\s*/, "").trim();
  }

  const metaParts = [];
  if (svc && !name.toLowerCase().includes(svc.toLowerCase())) {
    metaParts.push(svc);
  }
  if (detail && detail.toLowerCase() !== name.toLowerCase()) {
    metaParts.push(detail);
  }

  if (metaParts.length > 0) {
    lines.push(
      `<font color="#545B64" style="font-size:9.5px">${escapeXml(metaParts.join(" · "))}</font>`
    );
  }
  return lines.join("<br>");
}

/**
 * Computes evenly spaced port positions (0..1) for `count` edges on one side of a node.
 */
function distributePort(index, count, min = 0.28, max = 0.72) {
  if (count <= 1) return 0.5;
  const ratio = index / (count - 1);
  return Number((min + ratio * (max - min)).toFixed(3));
}

/**
 * Generates AWS Architecture draw.io `<mxfile>` XML from an architecture specification.
 */
export function generateAwsArchDrawioXml(spec, opts = {}) {
  const title = spec.title || "AWS アーキテクチャ構成図";
  const subtitle = spec.subtitle || "Terraform リソース構成 (実処理・データ層)";
  const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  const edges = Array.isArray(spec.edges) ? spec.edges : [];
  const genWarnings = Array.isArray(opts.warnings) ? opts.warnings : [];

  // 単一のアロケーターで固定セル・層ゾーン・リソースノード・エッジの
  // mxCell ID を一括採番する。元 ID が正規形で衝突しても連番で必ず避ける。
  const ids = createCellIdMap();
  const fx = (name) => ids.fixed(String(name));
  for (const n of nodes) n._cellId = fx(n.id);
  const cloudCellId = fx("aws_cloud");

  // Group nodes by active layer
  const activeLayers = [];
  for (const cfg of LAYER_CONFIG) {
    const layerNodes = nodes.filter((n) => n.layer === cfg.id);
    if (layerNodes.length > 0) {
      activeLayers.push({ ...cfg, nodes: layerNodes });
    }
  }
  // Fallback for any custom layer
  const knownIds = new Set(LAYER_CONFIG.map((c) => c.id));
  const extraNodes = nodes.filter((n) => !knownIds.has(n.layer));
  if (extraNodes.length > 0) {
    activeLayers.push({
      id: "other",
      title: "OTHER RESOURCES",
      accentColor: "#545B64",
      fillColor: "#F9FAFB",
      borderColor: "#D8DCE3",
      nodes: extraNodes,
    });
  }

  // Detect whether to place an external "Users / Client" icon outside AWS Cloud
  const entryNodes = nodes.filter(
    (n) => n.layer === "edge" && EXTERNAL_ENTRY_KINDS.has(n.kind)
  );
  const showExternalUsers = spec.showExternalUsers !== false && entryNodes.length > 0;

  // Layout geometry constants (generous whitespace & crisp proportions)
  const outerPadX = 32;
  const outerPadY = 22;
  const headerH = 54;
  const externalAreaW = showExternalUsers ? 116 : 0;
  const awsCloudX = outerPadX + externalAreaW;
  const awsCloudTopY = outerPadY + headerH + 18;
  const awsCloudPadX = 28;
  const awsCloudHeaderH = 46;
  const awsCloudPadBottom = 26;
  const layerGapX = 72;
  const layerWidth = 220;
  const layerHeaderH = 34;
  const nodeVerticalPitch = 148;

  // Uniform height for all tier zones inside AWS Cloud
  let maxLayerNodes = 1;
  for (const l of activeLayers) {
    if (l.nodes.length > maxLayerNodes) maxLayerNodes = l.nodes.length;
  }
  const layerHeight = Math.max(220, layerHeaderH + 34 + maxLayerNodes * nodeVerticalPitch);
  const awsCloudWidth =
    awsCloudPadX * 2 +
    activeLayers.length * layerWidth +
    Math.max(0, activeLayers.length - 1) * layerGapX;
  const awsCloudHeight = awsCloudHeaderH + layerHeight + awsCloudPadBottom;
  const totalCanvasWidth = externalAreaW + awsCloudWidth;

  const nodeLayoutMap = new Map();

  // Compute layer & node coordinates
  activeLayers.forEach((layer, lIdx) => {
    layer.relX = awsCloudPadX + lIdx * (layerWidth + layerGapX);
    layer.relY = awsCloudHeaderH;
    layer.absX = awsCloudX + layer.relX;
    layer.absY = awsCloudTopY + layer.relY;
    layer.index = lIdx;

    const availH = layerHeight - layerHeaderH - 24;
    const pitch = Math.min(
      nodeVerticalPitch,
      Math.floor(availH / Math.max(1, layer.nodes.length))
    );
    const totalUsedH = layer.nodes.length * pitch;
    const startY =
      layerHeaderH + 22 + Math.max(0, Math.floor((availH - totalUsedH) / 2));

    layer.nodes.forEach((n, nIdx) => {
      const preset = AWS_KIND_STYLES[n.kind] || AWS_KIND_STYLES.lambda;
      const w = Number(n.width || preset.width);
      const h = Number(n.height || preset.height);
      const relX = Math.round((layerWidth - w) / 2);
      const relY = startY + nIdx * pitch;

      nodeLayoutMap.set(n.id, {
        node: n,
        preset,
        layer,
        nIdx,
        relX,
        relY,
        absX: layer.absX + relX,
        absY: layer.absY + relY,
        width: w,
        height: h,
        centerX: layer.absX + relX + w / 2,
        centerY: layer.absY + relY + h / 2,
      });
    });
  });

  // Footer summary of omitted categories
  const omittedEntries = Object.entries(spec.omittedSummary || {});
  const omittedCount = omittedEntries.reduce((sum, [, c]) => sum + c, 0);
  const footerText =
    omittedCount > 0
      ? `省略された補助リソース (${omittedCount}件): ${omittedEntries
          .slice(0, 8)
          .map(([t, c]) => `${t}×${c}`)
          .join(", ")}${omittedEntries.length > 8 ? " ..." : ""}  — 必要時は --include security,network,iam で表示`
      : null;

  // Determine which edge types are present for the Legend
  const activeEdgeTypes = new Set(edges.map((e) => e.type || "flow"));
  if (showExternalUsers) activeEdgeTypes.add("flow");

  const xmlLines = [];
  xmlLines.push(`<mxfile host="drawio-aws-arch-skill" version="1.1.0">`);
  xmlLines.push(`  <diagram id="aws-arch-1" name="${escapeXml(title)}">`);
  xmlLines.push(
    `    <mxGraphModel dx="1400" dy="900" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="1200" background="#FFFFFF" shadow="0">`
  );
  xmlLines.push(`      <root>`);
  xmlLines.push(`        <mxCell id="0" />`);
  xmlLines.push(`        <mxCell id="1" parent="0" />`);

  // 1. Clean AWS-Branded Header Bar (AWS Orange accent strip + left-aligned title + right Legend)
  xmlLines.push(
    `        <mxCell id="${escapeXml(fx("header_accent"))}" value="" style="rounded=1;arcSize=50;whiteSpace=wrap;html=1;fillColor=#FF9900;strokeColor=none;" vertex="1" parent="1">`
  );
  xmlLines.push(
    `          <mxGeometry x="${outerPadX}" y="${outerPadY + 6}" width="5" height="${headerH - 12}" as="geometry" />`
  );
  xmlLines.push(`        </mxCell>`);

  const titleHtml = `<b style="font-size:18px;color:#232F3E">${escapeXml(title)}</b><br><font color="#545B64" style="font-size:11px">${escapeXml(subtitle)}</font>`;
  xmlLines.push(
    `        <mxCell id="${escapeXml(fx("title_text"))}" value="${escapeXml(titleHtml)}" style="text;html=1;align=left;verticalAlign=middle;whiteSpace=wrap;spacingLeft=4;" vertex="1" parent="1">`
  );
  xmlLines.push(
    `          <mxGeometry x="${outerPadX + 12}" y="${outerPadY}" width="${Math.max(420, totalCanvasWidth - 380)}" height="${headerH}" as="geometry" />`
  );
  xmlLines.push(`        </mxCell>`);

  // Compact Legend on the top-right
  const legendItems = [];
  if (activeEdgeTypes.has("flow")) {
    legendItems.push({ label: "Sync / Invoke", color: "#232F3E", dashed: false });
  }
  if (activeEdgeTypes.has("async")) {
    legendItems.push({ label: "Async / Event", color: "#D91B7A", dashed: true });
  }
  if (activeEdgeTypes.has("data")) {
    legendItems.push({ label: "Data / Storage", color: "#0073BB", dashed: false });
  }
  if (activeEdgeTypes.has("security")) {
    legendItems.push({ label: "Security", color: "#DD344C", dashed: true });
  }
  if (activeEdgeTypes.has("reference")) {
    legendItems.push({ label: "Static reference", color: "#8791A0", dashed: true });
  }
  if (legendItems.length > 0) {
    const itemW = 108;
    const legendW = legendItems.length * itemW + 18;
    const legendH = 30;
    const legendX = outerPadX + totalCanvasWidth - legendW;
    const legendY = outerPadY + Math.round((headerH - legendH) / 2);

    xmlLines.push(
      `        <mxCell id="${escapeXml(fx("legend_box"))}" value="" style="rounded=1;arcSize=18;whiteSpace=wrap;html=1;fillColor=#F8F9FA;strokeColor=#E2E6EC;strokeWidth=1;" vertex="1" parent="1">`
    );
    xmlLines.push(
      `          <mxGeometry x="${legendX}" y="${legendY}" width="${legendW}" height="${legendH}" as="geometry" />`
    );
    xmlLines.push(`        </mxCell>`);

    legendItems.forEach((item, idx) => {
      const ix = legendX + 10 + idx * itemW;
      const iy = legendY + Math.round(legendH / 2);
      const lineStyle = `endArrow=block;endFill=1;endSize=4;html=1;strokeWidth=1.6;strokeColor=${item.color};${item.dashed ? "dashed=1;dashPattern=4 2;" : ""}`;
      xmlLines.push(
        `        <mxCell id="${escapeXml(fx(`legend_line_${idx}`))}" value="" style="${lineStyle}" edge="1" parent="1">`
      );
      xmlLines.push(`          <mxGeometry relative="1" as="geometry">`);
      xmlLines.push(`            <mxPoint x="${ix}" y="${iy}" as="sourcePoint" />`);
      xmlLines.push(`            <mxPoint x="${ix + 24}" y="${iy}" as="targetPoint" />`);
      xmlLines.push(`          </mxGeometry>`);
      xmlLines.push(`        </mxCell>`);

      xmlLines.push(
        `        <mxCell id="${escapeXml(fx(`legend_lbl_${idx}`))}" value="${escapeXml(item.label)}" style="text;html=1;align=left;verticalAlign=middle;fontSize=10;fontColor=#3B424C;" vertex="1" parent="1">`
      );
      xmlLines.push(
        `          <mxGeometry x="${ix + 26}" y="${legendY + 4}" width="${itemW - 28}" height="${legendH - 8}" as="geometry" />`
      );
      xmlLines.push(`        </mxCell>`);
    });
  }

  // Subtle divider line below header
  xmlLines.push(
    `        <mxCell id="${escapeXml(fx("header_divider"))}" value="" style="endArrow=none;html=1;strokeWidth=1;strokeColor=#E5E8EC;" edge="1" parent="1">`
  );
  xmlLines.push(`          <mxGeometry relative="1" as="geometry">`);
  xmlLines.push(
    `            <mxPoint x="${outerPadX}" y="${outerPadY + headerH + 6}" as="sourcePoint" />`
  );
  xmlLines.push(
    `            <mxPoint x="${outerPadX + totalCanvasWidth}" y="${outerPadY + headerH + 6}" as="targetPoint" />`
  );
  xmlLines.push(`          </mxGeometry>`);
  xmlLines.push(`        </mxCell>`);

  // 2. External Users / Client icon outside AWS Cloud
  let externalUsersId = null;
  if (showExternalUsers) {
    externalUsersId = fx("external_users");
    const firstEntry = nodeLayoutMap.get(entryNodes[0].id);
    const uPreset = AWS_KIND_STYLES.users;
    const ux = outerPadX + Math.round((externalAreaW - 26 - uPreset.width) / 2);
    const uy = Math.round(firstEntry.centerY - uPreset.height / 2);
    const uLabel = `<b style="font-size:11px;color:#232F3E">Users / Client</b><br><font color="#545B64" style="font-size:9.5px">HTTPS</font>`;

    xmlLines.push(
      `        <mxCell id="${externalUsersId}" value="${escapeXml(uLabel)}" style="${escapeXml(uPreset.style)}" vertex="1" parent="1">`
    );
    xmlLines.push(
      `          <mxGeometry x="${ux}" y="${uy}" width="${uPreset.width}" height="${uPreset.height}" as="geometry" />`
    );
    xmlLines.push(`        </mxCell>`);
  }

  // 3. Outer AWS Cloud Container (Official AWS Cloud Group)
  xmlLines.push(
    `        <mxCell id="${escapeXml(cloudCellId)}" value="AWS Cloud" style="points=[[0,0],[0.25,0],[0.5,0],[0.75,0],[1,0],[1,0.25],[1,0.5],[1,0.75],[1,1],[0.75,1],[0.5,1],[0.25,1],[0,1],[0,0.75],[0,0.5],[0,0.25]];outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=13;fontStyle=1;fontColor=#232F3E;shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_aws_cloud_alt;strokeColor=#232F3E;fillColor=#FFFFFF;verticalAlign=top;align=left;spacingLeft=34;spacingTop=4;strokeWidth=1.6;" vertex="1" parent="1">`
  );
  xmlLines.push(
    `          <mxGeometry x="${awsCloudX}" y="${awsCloudTopY}" width="${awsCloudWidth}" height="${awsCloudHeight}" as="geometry" />`
  );
  xmlLines.push(`        </mxCell>`);

  // 4. Subtle Logical Tier Zones inside AWS Cloud (flat, clean, AWS Architecture Center style)
  for (const layer of activeLayers) {
    const layerId = fx(`layer_${layer.id}`);
    const zoneStyle = `rounded=1;arcSize=4;whiteSpace=wrap;html=1;fillColor=${layer.fillColor};strokeColor=${layer.borderColor};strokeWidth=1;dashed=1;dashPattern=4 3;verticalAlign=top;align=left;spacingTop=9;spacingLeft=14;fontSize=10;fontStyle=1;fontColor=#545B64;`;
    xmlLines.push(
      `        <mxCell id="${layerId}" value="${escapeXml(layer.title)}" style="${zoneStyle}" vertex="1" parent="${escapeXml(cloudCellId)}">`
    );
    xmlLines.push(
      `          <mxGeometry x="${layer.relX}" y="${layer.relY}" width="${layerWidth}" height="${layerHeight}" as="geometry" />`
    );
    xmlLines.push(`        </mxCell>`);

    // Subtle colored top accent bar on each tier zone
    xmlLines.push(
      `        <mxCell id="${escapeXml(ids.child(layerId, "accent"))}" value="" style="rounded=1;arcSize=50;whiteSpace=wrap;html=1;fillColor=${layer.accentColor};strokeColor=none;" vertex="1" parent="${escapeXml(layerId)}">`
    );
    xmlLines.push(
      `          <mxGeometry x="12" y="0" width="36" height="3" as="geometry" />`
    );
    xmlLines.push(`        </mxCell>`);

    // Nodes inside this tier
    for (const n of layer.nodes) {
      const layout = nodeLayoutMap.get(n.id);
      const labelHtml = formatResourceLabel(n);
      const style = n.style || layout.preset.style;
      xmlLines.push(
        `        <mxCell id="${escapeXml(n._cellId)}" value="${escapeXml(labelHtml)}" style="${escapeXml(style)}" vertex="1" parent="${layerId}">`
      );
      xmlLines.push(
        `          <mxGeometry x="${layout.relX}" y="${layout.relY}" width="${layout.width}" height="${layout.height}" as="geometry" />`
      );
      xmlLines.push(`        </mxCell>`);
    }
  }

  // 5. External Users -> Edge Entry Arrows
  if (externalUsersId) {
    entryNodes.forEach((en, idx) => {
      xmlLines.push(
        `        <mxCell id="${escapeXml(fx(`edge_external_${idx + 1}`))}" value="" style="${escapeXml(EDGE_STYLES.flow + "exitX=1;exitY=0.5;entryX=0;entryY=0.5;")}" edge="1" parent="1" source="${escapeXml(externalUsersId)}" target="${escapeXml(en._cellId)}">`
      );
      xmlLines.push(`          <mxGeometry relative="1" as="geometry" />`);
      xmlLines.push(`        </mxCell>`);
    });
  }

  // 6. Smart Non-Overlapping Orthogonal Edges between AWS Resources
  // First pass: count outgoing/incoming horizontal edges per node side for port staggering
  const rightOutGroups = new Map();
  const leftInGroups = new Map();
  const leftOutGroups = new Map();
  const rightInGroups = new Map();

  const resolvedEdges = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const src = nodeLayoutMap.get(e.from || e.source);
    const trg = nodeLayoutMap.get(e.to || e.target);
    if (!src || !trg) {
      // 未知ノード参照のエッジは黙って落とさず警告を残す
      genWarnings.push(
        `エッジ #${i + 1} (${String(e.from ?? e.source)} -> ${String(e.to ?? e.target)}) は` +
          `図中のノードを参照できないため接続線を結びませんでした。`
      );
      continue;
    }
    const dLayer = trg.layer.index - src.layer.index;
    const item = { index: i, e, src, trg, dLayer };
    resolvedEdges.push(item);

    if (dLayer > 0) {
      if (!rightOutGroups.has(src.node.id)) rightOutGroups.set(src.node.id, []);
      rightOutGroups.get(src.node.id).push(item);
      if (!leftInGroups.has(trg.node.id)) leftInGroups.set(trg.node.id, []);
      leftInGroups.get(trg.node.id).push(item);
    } else if (dLayer < 0) {
      if (!leftOutGroups.has(src.node.id)) leftOutGroups.set(src.node.id, []);
      leftOutGroups.get(src.node.id).push(item);
      if (!rightInGroups.has(trg.node.id)) rightInGroups.set(trg.node.id, []);
      rightInGroups.get(trg.node.id).push(item);
    }
  }

  // Sort port groups by target/source Y coordinate so lines don't unnecessarily cross
  for (const list of rightOutGroups.values()) {
    list.sort((a, b) => a.trg.centerY - b.trg.centerY || a.dLayer - b.dLayer);
  }
  for (const list of leftInGroups.values()) {
    list.sort((a, b) => a.src.centerY - b.src.centerY || a.dLayer - b.dLayer);
  }
  for (const list of leftOutGroups.values()) {
    list.sort((a, b) => a.trg.centerY - b.trg.centerY);
  }
  for (const list of rightInGroups.values()) {
    list.sort((a, b) => a.src.centerY - b.src.centerY);
  }

  // Track vertical gutter lanes so parallel vertical segments never overlap
  const gutterLaneCounts = new Map();
  function allocateGutterX(leftLayerIdx) {
    const used = gutterLaneCounts.get(leftLayerIdx) || 0;
    gutterLaneCounts.set(leftLayerIdx, used + 1);
    const baseGapLeft = activeLayers[leftLayerIdx].absX + layerWidth;
    // Spread tracks across the 72px gutter cleanly (center-outward)
    const offsets = [0.5, 0.34, 0.66, 0.22, 0.78, 0.14, 0.86];
    const frac = offsets[used % offsets.length];
    return Math.round(baseGapLeft + layerGapX * frac);
  }

  // Track horizontal corridor segments { y, fromIdx, toIdx } so no two multi-layer edges share the same horizontal Y
  const usedHorizontalCorridors = [];
  function reserveClearHorizontalY(preferredY, fromIdx, toIdx) {
    let candidateY = Math.round(preferredY);
    const overlapsExisting = (y) =>
      usedHorizontalCorridors.some(
        (c) =>
          Math.abs(c.y - y) < 16 &&
          Math.max(c.fromIdx, fromIdx) < Math.min(c.toIdx, toIdx)
      );

    if (overlapsExisting(candidateY) || isHorizontalCorridorBlocked(candidateY, fromIdx, toIdx)) {
      for (let step = 1; step <= 12; step++) {
        for (const dir of [-1, 1]) {
          const tryY = candidateY + dir * step * 18;
          if (
            tryY > awsCloudTopY + awsCloudHeaderH + layerHeaderH + 8 &&
            !overlapsExisting(tryY) &&
            !isHorizontalCorridorBlocked(tryY, fromIdx, toIdx)
          ) {
            candidateY = tryY;
            usedHorizontalCorridors.push({ y: candidateY, fromIdx, toIdx });
            return candidateY;
          }
        }
      }
    }
    usedHorizontalCorridors.push({ y: candidateY, fromIdx, toIdx });
    return candidateY;
  }

  /**
   * Checks whether a horizontal segment at `y` between `fromLayerIdx + 1` and `toLayerIdx - 1`
   * would intersect any node icon or its 2-line label underneath.
   */
  function isHorizontalCorridorBlocked(y, fromLayerIdx, toLayerIdx) {
    for (let midIdx = fromLayerIdx + 1; midIdx < toLayerIdx; midIdx++) {
      const midLayer = activeLayers[midIdx];
      for (const mn of midLayer.nodes) {
        const ml = nodeLayoutMap.get(mn.id);
        if (!ml) continue;
        const topBound = ml.absY - 12;
        const botBound = ml.absY + ml.height + (ml.preset.isIcon ? 42 : 10);
        if (y >= topBound && y <= botBound) {
          return ml;
        }
      }
    }
    return null;
  }

  for (const item of resolvedEdges) {
    const { index: i, e, src, trg, dLayer } = item;
    const edgeId = fx(e.id || `edge_${i + 1}`);
    const baseStyle = e.style || EDGE_STYLES[e.type || "flow"] || EDGE_STYLES.flow;
    let portStyle = "";
    const waypoints = Array.isArray(e.waypoints) ? [...e.waypoints] : [];

    const dIdx = trg.nIdx - src.nIdx;

    if (dLayer > 0) {
      const outGroup = rightOutGroups.get(src.node.id);
      const inGroup = leftInGroups.get(trg.node.id);
      const exitY = distributePort(outGroup.indexOf(item), outGroup.length);
      const entryY = distributePort(inGroup.indexOf(item), inGroup.length);
      portStyle = `exitX=1;exitY=${exitY};entryX=0;entryY=${entryY};`;

      const startY = Math.round(src.absY + src.height * exitY);
      const endY = Math.round(trg.absY + trg.height * entryY);

      if (waypoints.length === 0) {
        if (dLayer === 1) {
          // Adjacent layers: assign a unique X in the shared gutter if vertical drop is needed
          if (Math.abs(startY - endY) > 4) {
            const gx = allocateGutterX(src.layer.index);
            waypoints.push({ x: gx, y: startY }, { x: gx, y: endY });
          }
        } else {
          // Multi-layer jump: pick a collision-free horizontal corridor Y
          const blockedAtEnd = isHorizontalCorridorBlocked(
            endY,
            src.layer.index,
            trg.layer.index
          );
          const blockedAtStart = isHorizontalCorridorBlocked(
            startY,
            src.layer.index,
            trg.layer.index
          );
          const preferredY = !blockedAtEnd
            ? endY
            : !blockedAtStart
              ? startY
              : blockedAtEnd.absY - 24;
          const corridorY = reserveClearHorizontalY(
            preferredY,
            src.layer.index,
            trg.layer.index
          );
          const midX1 = allocateGutterX(src.layer.index);
          const midX2 = allocateGutterX(trg.layer.index - 1);

          if (Math.abs(corridorY - startY) <= 2 && Math.abs(corridorY - endY) <= 2) {
            // Straight shot across layers
          } else if (Math.abs(corridorY - endY) <= 2) {
            waypoints.push({ x: midX1, y: startY }, { x: midX1, y: endY });
          } else if (Math.abs(corridorY - startY) <= 2) {
            waypoints.push({ x: midX2, y: startY }, { x: midX2, y: endY });
          } else {
            waypoints.push(
              { x: midX1, y: startY },
              { x: midX1, y: corridorY },
              { x: midX2, y: corridorY },
              { x: midX2, y: endY }
            );
          }
        }
      }
    } else if (dLayer < 0) {
      const outGroup = leftOutGroups.get(src.node.id);
      const inGroup = rightInGroups.get(trg.node.id);
      const exitY = distributePort(outGroup.indexOf(item), outGroup.length);
      const entryY = distributePort(inGroup.indexOf(item), inGroup.length);
      portStyle = `exitX=0;exitY=${exitY};entryX=1;entryY=${entryY};`;

      const startY = Math.round(src.absY + src.height * exitY);
      const endY = Math.round(trg.absY + trg.height * entryY);

      if (waypoints.length === 0 && Math.abs(startY - endY) > 4) {
        const gx = allocateGutterX(src.layer.index - 1);
        waypoints.push({ x: gx, y: startY }, { x: gx, y: endY });
      }
    } else if (dIdx > 0) {
      // Same layer, downward
      const labelDy = 38;
      const exitBot = src.preset.isIcon
        ? `exitX=0.5;exitY=1;exitDx=0;exitDy=${labelDy};exitPerimeter=0;`
        : "exitX=0.5;exitY=1;";
      portStyle = `${exitBot}entryX=0.5;entryY=0;`;
    } else {
      // Same layer, upward
      const labelDy = 38;
      const entryBot = trg.preset.isIcon
        ? `entryX=0.5;entryY=1;entryDx=0;entryDy=${labelDy};entryPerimeter=0;`
        : "entryX=0.5;entryY=1;";
      portStyle = `exitX=0.5;exitY=0;${entryBot}`;
    }

    xmlLines.push(
      `        <mxCell id="${escapeXml(edgeId)}" value="${escapeXml(e.label || "")}" style="${escapeXml(baseStyle + portStyle)}" edge="1" parent="1" source="${escapeXml(src.node._cellId)}" target="${escapeXml(trg.node._cellId)}">`
    );
    if (waypoints.length > 0) {
      xmlLines.push(`          <mxGeometry relative="1" as="geometry">`);
      xmlLines.push(`            <Array as="points">`);
      for (const wp of waypoints) {
        xmlLines.push(`              <mxPoint x="${wp.x}" y="${wp.y}" />`);
      }
      xmlLines.push(`            </Array>`);
      xmlLines.push(`          </mxGeometry>`);
    } else {
      xmlLines.push(`          <mxGeometry relative="1" as="geometry" />`);
    }
    xmlLines.push(`        </mxCell>`);
  }

  // 7. Optional Omitted-Resources Footer Note
  if (footerText) {
    const footerY = awsCloudTopY + awsCloudHeight + 12;
    xmlLines.push(
      `        <mxCell id="${escapeXml(fx("omitted_footer"))}" value="${escapeXml(footerText)}" style="text;html=1;align=left;verticalAlign=middle;fontSize=10.5;fontColor=#687078;" vertex="1" parent="1">`
    );
    xmlLines.push(
      `          <mxGeometry x="${awsCloudX}" y="${footerY}" width="${awsCloudWidth}" height="22" as="geometry" />`
    );
    xmlLines.push(`        </mxCell>`);
  }

  xmlLines.push(`      </root>`);
  xmlLines.push(`    </mxGraphModel>`);
  xmlLines.push(`  </diagram>`);
  xmlLines.push(`</mxfile>`);

  return xmlLines.join("\n");
}

const HELP_TEXT = `
build-aws-arch.mjs - Terraform -> AWS Architecture Diagram (.drawio + .drawio.png) Generator

Usage:
  node scripts/build-aws-arch.mjs --tf-dir <terraform-dir> [-o aws-arch.drawio.png] [options]
  node scripts/build-aws-arch.mjs --spec <arch.json> [-o aws-arch.drawio.png] [options]

Options:
  -d, --tf-dir <path>       Directory containing Terraform .tf files
  -i, --spec <path>         Pre-extracted / curated architecture JSON spec
  -o, --output <path>       Output PNG or SVG file path (default: aws-arch.drawio.png)
      --xml-out <path>      Output .drawio XML file path
      --json-out <path>     Save extracted JSON spec when using --tf-dir
      --include <list>      Optional categories to include (comma-separated):
                            security, network, iam, observability, all
      --title <text>        Custom diagram title
      --subtitle <text>     Custom diagram subtitle
  -s, --scale <number>      PNG scale factor (default: 2)
  -b, --border <px>         Border padding in pixels (default: 16)
      --theme <theme>       Color theme: light | dark (default: light)
  -h, --help                Show help
`.trim();

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      "tf-dir": { type: "string", short: "d" },
      spec: { type: "string", short: "i" },
      output: { type: "string", short: "o" },
      "xml-out": { type: "string" },
      "json-out": { type: "string" },
      include: { type: "string", default: "" },
      title: { type: "string" },
      subtitle: { type: "string" },
      scale: { type: "string", short: "s", default: "2" },
      border: { type: "string", short: "b", default: "16" },
      theme: { type: "string", default: "light" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help || (!values["tf-dir"] && !values.spec && positionals.length === 0)) {
    console.log(HELP_TEXT);
    process.exit(values.help ? 0 : 1);
  }

  // --- 入力・出力の衝突検査（必ず「最初の書き込み」より前に行う） -----------
  // --json-out はスキャン直後に書き込まれるため、検査が後になるとスキャン対象の
  // .tf そのものへ JSON を書き込んで原文を失う。ここでは 1 バイトも書き込まずに
  // エラー終了する。
  const tfDir = values["tf-dir"] || positionals[0];
  const outPath = values.output || "aws-arch.drawio.png";
  const xmlOutPath =
    values["xml-out"] ||
    outPath.replace(/\.drawio\.png$|\.png$|\.svg$/i, "") + ".drawio";
  const tfFiles = values.spec
    ? []
    : (await expandInputPaths(tfDir ? [tfDir] : [], /\.tf$/i)).files;

  assertOutputsDistinctFromInputs({
    inputs: values.spec
      ? [{ role: "--spec", value: values.spec }]
      : [{ role: "--tf-dir", value: tfDir, files: tfFiles }],
    outputs: [
      { role: "--json-out", value: values["json-out"] },
      { role: "--xml-out", value: xmlOutPath },
      { role: "--output", value: outPath },
    ],
  });

  let spec;
  if (values.spec) {
    spec = JSON.parse(await fs.readFile(values.spec, "utf8"));
    if (values.title) spec.title = values.title;
    if (values.subtitle) spec.subtitle = values.subtitle;
  } else {
    const includeCategories = values.include
      ? values.include.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    spec = await scanTerraformDirectory(tfDir, {
      includeCategories,
      title: values.title,
      subtitle: values.subtitle,
    });
    if (values["json-out"]) {
      await fs.mkdir(path.dirname(path.resolve(values["json-out"])), { recursive: true });
      await fs.writeFile(values["json-out"], JSON.stringify(spec, null, 2), "utf8");
      console.log(`Generated JSON: ${values["json-out"]}`);
    }
  }

  const genWarnings = [];
  const xml = generateAwsArchDrawioXml(spec, { warnings: genWarnings });

  const parsedScale = parseFloat(values.scale);
  const scale = Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : 2;
  const parsedBorder = parseInt(values.border, 10);
  const border = Number.isFinite(parsedBorder) && parsedBorder >= 0 ? parsedBorder : 16;

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

  for (const w of Array.isArray(spec.warnings) ? spec.warnings : []) {
    console.warn(`[warn] ${w}`);
  }
  for (const w of genWarnings) {
    console.warn(`[warn] ${w}`);
  }
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => {
    console.error("Error:", err.message || err);
    process.exit(1);
  });
}
