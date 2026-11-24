#!/usr/bin/env node
/**
 * scan-classes.mjs — TypeScript / JavaScript ソース簡易スキャナ (Pure Node.js / ゼロ依存)
 *
 * `.ts` / `.tsx` / `.js` / `.mjs` / `.cjs` ファイルから
 * `class` / `interface` / `enum` と、そのメンバー（プロパティ・メソッド）、
 * `extends` / `implements` 関係を正規表現 + カーリー括弧トラバースで簡易抽出し、
 * `build-class.mjs` が受け取れる JSON spec に変換する。
 *
 * 制限（意図的な簡易実装）:
 *   - 構文パーサーではないため、複雑なジェネリクス・デコレータ・条件付き型は
 *     荒く吸収する（注釈として {static} 等のタグのみ付与）
 *   - テンプレートリテラル内の `${...}` は中身の括弧を追跡しない
 *   - クラス宣言は行頭からの宣言のみ抽出（関数内のローカルクラスは対象外）
 *
 * 使用例:
 *   node scripts/scan-classes.mjs --src-dir ./src -o spec.json
 *   node scripts/scan-classes.mjs --src-dir ./src --packages
 */

import fsSync from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isDirectRun } from "./diagram-shared.mjs";

const DEFAULT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  "vendor",
  "__tests__",
  "__mocks__",
]);

const CLASS_RE =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)\s*(?:<[^{]*?>)?\s*(?:extends\s+([^{]+?))?\s*(?:implements\s+([^{]+?))?\s*\{/gm;
const INTERFACE_RE =
  /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)\s*(?:<[^{]*?>)?\s*(?:extends\s+([^{]+?))?\s*\{/gm;
const ENUM_RE =
  /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)\s*\{/gm;

const MOD_RE =
  /^(?:(public|private|protected|static|readonly|abstract|async|override|declare|get|set)\s+)*/;

// ---------------------------------------------------------------------------
// 前処理: コメント除去（文字列・テンプレートリテラル内は無視）
// ---------------------------------------------------------------------------

export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          out += quote;
          i += 1;
          break;
        }
        out += src[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** `{` の位置（`{` 自体のインデックス）から対応する `}` 直前までを返す */
export function extractBracedBody(cleanSrc, openBraceIndex) {
  let depth = 0;
  let i = openBraceIndex;
  const n = cleanSrc.length;
  while (i < n) {
    const ch = cleanSrc[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (cleanSrc[i] === "\\") {
          i += 2;
          continue;
        }
        if (cleanSrc[i] === quote) break;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return cleanSrc.slice(openBraceIndex + 1, i);
    }
    i += 1;
  }
  return cleanSrc.slice(openBraceIndex + 1);
}

/** 型体のトップレベル（深さ 0）だけをメンバー断片に分割する */
export function splitTopLevelMembers(body) {
  const chunks = [];
  let cur = "";
  let depth = 0;
  let i = 0;
  const n = body.length;
  const push = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
    cur = "";
  };
  while (i < n) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      cur += ch;
      i += 1;
      while (i < n) {
        if (body[i] === "\\") {
          cur += body.slice(i, i + 2);
          i += 2;
          continue;
        }
        cur += body[i];
        if (body[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "{" && depth === 0) {
      // メンバー本体の開始。対応する } まで丸ごとスキップ
      let d = 1;
      i += 1;
      while (i < n && d > 0) {
        const c = body[i];
        if (c === '"' || c === "'" || c === "`") {
          const quote = c;
          i += 1;
          while (i < n) {
            if (body[i] === "\\") {
              i += 2;
              continue;
            }
            if (body[i] === quote) break;
            i += 1;
          }
        } else if (c === "{") d += 1;
        else if (c === "}") d -= 1;
        i += 1;
      }
      push();
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    if (ch === ";" && depth === 0) {
      push();
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  push();
  return chunks;
}

/** enum 本体をトップレベルの `,` で分割する */
export function splitEnumMembers(body) {
  const parts = [];
  let depth = 0;
  let cur = "";
  let i = 0;
  const n = body.length;
  const push = () => {
    const t = cur.trim();
    if (t) parts.push(t);
    cur = "";
  };
  while (i < n) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      cur += ch;
      i += 1;
      while (i < n) {
        if (body[i] === "\\") {
          cur += body.slice(i, i + 2);
          i += 2;
          continue;
        }
        cur += body[i];
        if (body[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if ("([{<".includes(ch)) depth += 1;
    else if (")]}>".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) {
      push();
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  push();
  return parts;
}

// ---------------------------------------------------------------------------
// メンバー整形
// ---------------------------------------------------------------------------

function collapse(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

function visibilityOf(mods) {
  if (/(^|[\s(])private(\s|$)/.test(mods) || mods.includes("#")) return "-";
  if (/(^|[\s(])protected(\s|$)/.test(mods)) return "#";
  return "+";
}

function staticTag(mods) {
  return /(^|\s)static(\s|$)/.test(mods) ? " {static}" : "";
}

function parseTypeNameList(s) {
  if (!s) return [];
  return collapse(s)
    .split(",")
    .map((t) => t.replace(/<[^<>]*>/g, "").trim())
    .filter((t) => t && /^[A-Za-z_$][\w$.]*$/.test(t));
}

function formatMember(chunk) {
  const text = collapse(chunk).replace(/;$/, "");
  if (!text || text.startsWith("@") || text.startsWith("[")) return null;

  // コンストラクタのパラメータプロパティ → 属性として展開
  const ctor = text.match(
    /^(?:(?:public|private|protected|static|readonly|override)\s+)*constructor\s*\(([\s\S]*)\)$/
  );
  if (ctor) {
    const props = [];
    for (const raw of splitArgs(ctor[1])) {
      const p = collapse(raw);
      const m = p.match(
        /^(private|protected|public|readonly)\s+(readonly\s+)?([#A-Za-z_$][\w$]*)\s*(\?|!)?\s*(?::\s*([\s\S]+))?$/
      );
      if (m) {
        const vis = m[1] === "private" ? "-" : m[1] === "protected" ? "#" : "+";
        props.push(`${vis} ${m[3]}: ${collapse(m[5] || "any")}`);
      }
    }
    return { kind: "ctor", props };
  }

  // メソッド: 括弧を持つ（getter/setter 含む）
  const method = text.match(
    /^(?<mods>(?:(?:public|private|protected|static|readonly|abstract|async|override|get|set|declare)\s+)*)(?<name>[#]?[A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*\((?<args>[\s\S]*)\)\s*(?::\s*(?<ret>[^{;]+))?$/
  );
  if (method) {
    const vis = visibilityOf(method.groups.mods);
    const args = splitArgs(method.groups.args)
      .map((a) => collapse(a).replace(/\s*=\s*[\s\S]*$/, ""))
      .filter(Boolean);
    const ret = collapse(method.groups.ret || "void");
    return { kind: "method", line: `${vis} ${method.groups.name}(${args.join(", ")})${ret ? `: ${ret}` : ""}` };
  }

  // 列挙定数
  const enumConst = text.match(/^([A-Za-z_$][\w$]*)\s*(?:=.*)?$/);
  if (enumConst) return { kind: "property", line: enumConst[1] };

  // プロパティ
  const prop = text.match(
    /^(?<mods>(?:(?:public|private|protected|static|readonly|abstract|declare|override)\s+)*)(?<name>[#]?[A-Za-z_$][\w$]*)\s*(?:\?|!)?\s*(?::\s*(?<type>[\s\S]+?))?(?:\s+[\s\S]+)?$/
  );
  if (prop && !/^\(/.test(text)) {
    const vis = visibilityOf(prop.groups.mods);
    const type = collapse(prop.groups.type || "");
    return {
      kind: "property",
      line: `${vis} ${prop.groups.name}${type ? `: ${type}` : ""}${staticTag(prop.groups.mods)}`,
    };
  }
  return null;
}

function splitArgs(s) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if ("([{<".includes(ch)) depth += 1;
    else if (")]}>".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// ---------------------------------------------------------------------------
// ファイル単位スキャン
// ---------------------------------------------------------------------------

function scanSourceCode(code, relPath) {
  const clean = stripComments(code);
  const found = [];

  const collect = (re, build) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(clean))) {
      const open = m.index + m[0].length - 1;
      const body = extractBracedBody(clean, open);
      found.push(build(body, m));
    }
  };

  collect(CLASS_RE, (body, m) => {
    const [, abstractKw, name, extendsPart, implementsPart] = m;
    const attributes = [];
    const methods = [];
    for (const chunk of splitTopLevelMembers(body)) {
      const parsed = formatMember(chunk);
      if (!parsed) continue;
      if (parsed.kind === "ctor") {
        attributes.push(...parsed.props);
        if (chunk.length > 0) methods.push("+ constructor(...)");
      } else if (parsed.kind === "method") methods.push(parsed.line);
      else attributes.push(parsed.line);
    }
    return {
      id: name,
      name,
      stereotype: abstractKw ? "abstract" : "default",
      file: relPath,
      attributes,
      methods,
      extends: parseTypeNameList(extendsPart),
      implements: parseTypeNameList(implementsPart),
    };
  });

  collect(INTERFACE_RE, (body, m) => {
    const [, name, extendsPart] = m;
    const attributes = [];
    const methods = [];
    for (const chunk of splitTopLevelMembers(body)) {
      const parsed = formatMember(chunk);
      if (!parsed) continue;
      if (parsed.kind === "method") methods.push(parsed.line);
      else if (parsed.kind === "property") attributes.push(parsed.line);
    }
    return {
      id: name,
      name,
      stereotype: "interface",
      file: relPath,
      attributes,
      methods,
      extends: parseTypeNameList(extendsPart),
      implements: [],
    };
  });

  collect(ENUM_RE, (body, m) => {
    const [, name] = m;
    const members = [];
    for (const chunk of splitEnumMembers(body)) {
      const ident = collapse(chunk).match(/^([A-Za-z_$][\w$]*)/);
      if (ident) members.push(ident[1]);
    }
    return {
      id: name,
      name,
      stereotype: "enum",
      file: relPath,
      attributes: members,
      methods: [],
      extends: [],
      implements: [],
    };
  });

  return found;
}

function dedupeNames(types) {
  const seen = new Map();
  for (const t of types) {
    t.origName = t.name; // 元名（extends / implements の解決に使う。name は表示用に変わるので）
    const key = t.name.toLowerCase();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    if (count > 0) {
      t.id = `${t.name}_${count + 1}`;
      t.name = `${t.name} (${path.basename(t.file)})`;
    }
  }
}

async function walkFiles(dir, out, depth = 0) {
  if (depth > 24) return;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      await walkFiles(full, out, depth + 1);
    } else if (e.isFile()) {
      if (e.name.endsWith(".d.ts")) continue;
      if (/\.(test|spec|stories)\.[cm]?[jt]sx?$/i.test(e.name)) continue;
      if (DEFAULT_EXTENSIONS.has(path.extname(e.name))) out.push(full);
    }
  }
}

/**
 * ディレクトリを再帰スキャンし、build-class.mjs 用 JSON spec を返す。
 * @param {string} dir
 * @param {{title?: string, subtitle?: string, packages?: boolean}} [opts]
 */
export async function scanDirectory(dir, opts = {}) {
  const root = path.resolve(dir);
  const files = [];
  await walkFiles(root, files);
  files.sort();

  const types = [];
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const code = await fsp.readFile(file, "utf8");
    for (const t of scanSourceCode(code, rel)) {
      const pkg = path.posix.dirname(rel);
      t.package = pkg === "." ? undefined : pkg.split("/")[0];
      types.push(t);
    }
  }
  dedupeNames(types);

  // 参照名 → 型候補の対応（同名型が別ファイルに複数ある場合の解決用）。
  const byOrigName = new Map();
  for (const t of types) {
    const key = (t.origName || t.name).toLowerCase();
    if (!byOrigName.has(key)) byOrigName.set(key, []);
    byOrigName.get(key).push(t);
  }

  /**
   * `extends` / `implements` の参照名を型へ解決する。
   * 同じ名前の型が複数ファイルに定義されているときは、**同一ファイル内の宣言を優先**する
   * （ファイルローカルな同名型を別ファイルの型と取り違えない）。
   */
  const resolveTypeRef = (from, ref) => {
    const cands = byOrigName.get(String(ref).toLowerCase()) || [];
    const usable = cands.filter((x) => x !== from);
    if (!usable.length) return null;
    const sameFile = usable.find((x) => x.file === from.file);
    return sameFile || usable[0];
  };

  const relations = [];
  const relSeen = new Set();
  const pushRel = (from, to, type) => {
    const key = `${from}\u0000${to}\u0000${type}`;
    if (relSeen.has(key)) return;
    relSeen.add(key);
    relations.push({ from, to, type });
  };
  for (const t of types) {
    // `extends` は常に inheritance（UML の汎化）。
    // interface A extends B は「B の特殊化」であり implementation ではない。
    // class が interface を実装する関係は implements 側から implementation になる。
    for (const base of t.extends) {
      const baseType = resolveTypeRef(t, base);
      if (!baseType) continue;
      pushRel(t.id, baseType.id, "inheritance");
    }
    for (const itf of t.implements) {
      const baseType = resolveTypeRef(t, itf);
      if (!baseType) continue;
      pushRel(t.id, baseType.id, "implementation");
    }
  }

  // --packages 時はパッケージ単位で行を割り当て、破線枠が重ならないようにする
  let rowCursor = 0;
  const rowByPkg = new Map();
  const colByPkg = new Map();
  const classes = types.map((t) => {
    const spec = {
      id: t.id,
      name: t.name,
      stereotype: t.stereotype,
      attributes: t.attributes,
      methods: t.methods,
    };
    if (t.package) spec.package = t.package;
    if (opts.packages && t.package) {
      if (!rowByPkg.has(t.package)) {
        rowByPkg.set(t.package, rowCursor++);
        colByPkg.set(t.package, 0);
      }
      spec.row = rowByPkg.get(t.package);
      spec.col = colByPkg.get(t.package);
      colByPkg.set(t.package, spec.col + 1);
    }
    return spec;
  });

  const packages = opts.packages
    ? [...rowByPkg.keys()].map((id) => ({ id, label: id }))
    : [];

  return {
    title: opts.title || "Class Diagram",
    subtitle:
      opts.subtitle ??
      `scanned ${files.length} file(s) / ${classes.length} type(s) from ${dir}`,
    ...(packages.length ? { packages } : {}),
    classes,
    relations,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP_TEXT = `
scan-classes.mjs - TypeScript / JavaScript -> class diagram JSON spec scanner (zero dependency)

Usage:
  node scan-classes.mjs --src-dir <dir> [options]

Options:
  -o, --output <path>   Output JSON spec (default: stdout)
      --packages        Assign one grid row per top-level folder (draw package boxes)
      --title <text>    Spec title
      --subtitle <text> Spec subtitle
  -h, --help            Show this help message
`.trim();

async function runCli(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "src-dir": { type: "string" },
      output: { type: "string", short: "o" },
      packages: { type: "boolean", default: false },
      title: { type: "string" },
      subtitle: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !values["src-dir"]) {
    console.log(HELP_TEXT);
    process.exit(values.help ? 0 : 1);
  }
  const spec = await scanDirectory(values["src-dir"], {
    packages: values.packages,
    title: values.title,
    subtitle: values.subtitle,
  });
  const json = JSON.stringify(spec, null, 2) + "\n";
  if (values.output) {
    await fsp.mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
    await fsp.writeFile(values.output, json, "utf8");
    console.log(
      `${values.output} (${spec.classes.length} classes, ${spec.relations.length} relations)`
    );
  } else {
    process.stdout.write(json);
  }
}

if (isDirectRun(import.meta.url)) {
  runCli().catch((err) => {
    console.error("Error:", err.message || err);
    process.exit(1);
  });
}
