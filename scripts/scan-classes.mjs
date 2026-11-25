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
import {
  assertOutputsDistinctFromInputs,
  isDirectRun,
  resolveWriteTarget,
  writeFileAtomic,
} from "./diagram-shared.mjs";

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

/**
 * コメントを除去する。既定では文字列・テンプレートリテラルの中身も空白に置き換える
 * （クラス本体の走査で文字列内の `{` や修飾子語を誤検出しないため）。
 * `keepStrings: true` を渡すと文字列の中身をそのまま残す。import 先パスのように
 * リテラルの値を読む走査ではこちらのモードを使う。
 */
export function stripComments(src, opts = {}) {
  const keepStrings = opts.keepStrings === true;
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
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        if (src[i] === "\\") {
          const step = Math.min(2, n - i);
          out += keepStrings ? src.slice(i, i + step) : " ".repeat(step);
          i += step;
          continue;
        }
        if (src[i] === quote) {
          out += quote;
          i += 1;
          break;
        }
        if (keepStrings) {
          out += src[i];
          i += 1;
          continue;
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

const MODULE_EXT_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

/**
 * ES モジュール / CJS / 通常 TS で、import 指定子の拡張子から参照を許す実装拡張子の組。
 * ESM TypeScript では `./base.mjs` -> `base.mts` / `base.mjs` のように同じモジュール系統に限定し、
 * `base.mts` と `base.cts` が同居している環境で `./base.mjs` が `base.cts` に誤解決されないようにする。
 */
const COMPATIBLE_SOURCE_EXTS = {
  ".mjs": [".mts", ".mjs"],
  ".mts": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
  ".cts": [".cts", ".cjs"],
  ".js": [".ts", ".tsx", ".js", ".jsx"],
  ".jsx": [".tsx", ".jsx", ".ts", ".js"],
  ".ts": [".ts", ".tsx"],
  ".tsx": [".tsx", ".ts"],
};

/**
 * 相対 import 先を `{ modulePath, specExt }` へ分解する（"./b.mjs" -> { modulePath: "domain/b", specExt: ".mjs" }）。
 * @returns {{ modulePath: string, specExt: string }}
 */
function parseImportTarget(fromRel, spec) {
  const dir = path.posix.dirname(fromRel);
  const joined = path.posix.normalize(path.posix.join(dir, spec));
  const extMatch = joined.match(MODULE_EXT_RE);
  const specExt = extMatch ? extMatch[0].toLowerCase() : "";
  const stripped = joined.replace(MODULE_EXT_RE, "");
  const modulePath = stripped.length > 1 ? stripped.replace(/\/+$/, "") : stripped;
  return { modulePath, specExt };
}

/** 相対 import 先を拡張子なしの正規化相対パスへ直す（"./b" -> "domain/b"）。 */
function normalizeImportTarget(fromRel, spec) {
  return parseImportTarget(fromRel, spec).modulePath;
}

/**
 * 相対 import / export の指定子を、このファイルが参照しているモジュールパスの
 * 一覧として取り出す。同名型が複数ファイルに定義されているとき、
 * 「どちらの宣言を指しているのか」を決める根拠に使う。
 * @param {string} src コメント除去済み（または生）ソース（文字列リテラル保持可）
 * @param {string} [preClean] 文字列リテラル中身も空白化した同長ソース
 */
function extractRelativeImports(src, preClean) {
  const stringsKept = preClean ? src : stripComments(src, { keepStrings: true });
  const masked = preClean ?? stripComments(src);
  const specs = new Set();
  const res = [
    /(?<!\.)\bimport\s+(?:type\s+)?[^;"'`]*?\bfrom\s*(["'`])([^"'`\r\n]+)\1/gd,
    /(?<!\.)\bexport\s+(?:type\s+)?[^;"'`]*?\bfrom\s*(["'`])([^"'`\r\n]+)\1/gd,
    /(?<!\.)\bimport\s*\(\s*(["'`])([^"'`\r\n]+)\1\s*\)/gd,
    /(?<!\.)\bimport\s*(["'`])([^"'`\r\n]+)\1/gd,
  ];
  for (const re of res) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked))) {
      const [start, end] = m.indices[2];
      const spec = stringsKept.slice(start, end);
      if (/^\.\.?\//.test(spec)) specs.add(spec);
    }
  }
  return [...specs];
}

/**
 * import 句（`from` の左側）を解析して、
 * ローカル識別子 →（モジュールで宣言されていた元名）の対応を取り出す。
 * `import Def, { A, B as C } from "./m"` のような混在形も扱う。
 * @returns {Array<{localName: string, importedName: string}>} `importedName` が "default" は既定 import
 */
function parseImportClause(clause) {
  const out = [];
  const blocks = [];
  const rest = String(clause).replace(/\{([^{}]*)\}/g, (_m, inner) => {
    blocks.push(inner);
    return " ";
  });
  const splitAs = (s) => {
    const parts = s.split(/\s+as\s+/);
    return { from: parts[0].trim(), to: (parts[1] || parts[0]).trim() };
  };
  const ident = (s) => /^[A-Za-z_$][\w$]*$/.test(s);

  for (const block of blocks) {
    for (const raw of block.split(",")) {
      const item = raw.trim().replace(/^type\s+/, "").trim();
      if (!item) continue;
      const { from, to } = splitAs(item);
      if (!ident(from) || !ident(to)) continue; // `* as ns`・インデックス名などは対象外
      out.push({ localName: to, importedName: from });
    }
  }
  for (const raw of rest.split(",")) {
    const item = raw.trim().replace(/^type\s+/, "").trim();
    if (!item || item.startsWith("*")) continue; // namespace import は単一識別子を決める根拠にしない
    const { to } = splitAs(item);
    if (!ident(to)) continue;
    out.push({ localName: to, importedName: "default" });
  }
  return out;
}

/**
 * シンボル単位の相対 import を解析し、ローカル識別子名ごとに解決先を持つ Map を作る。
 * 扱う形（`import type` / 既定 import / 混在形を含む）:
 *   import { A, B as C } from "./m";   import type { A } from "./m";
 *   import Def from "./m";             import Def, { A } from "./m";
 * 同名型が複数ファイルに定義されているとき、「どのモジュールのどの名前を指しているか」の
 * 最も強い根拠にする（`from.imports` だけでは import した全モジュールから区別できない）。
 * @param {string} src コメントだけ落として文字列は残したソース（または生ソース）
 * @param {string} fromRel このファイルの走査根からの相対パス
 * @param {string} [preClean] 文字列リテラル中身を空白化した同長ソース
 */
export function extractImportedSymbols(src, fromRel, preClean) {
  const stringsKept = preClean ? src : stripComments(src, { keepStrings: true });
  const masked = preClean ?? stripComments(src);
  const map = new Map();
  const re = /(?<!\.)\bimport\s+([^;"'`]*?)\s*\bfrom\s*(["'`])([^"'`\r\n]+)\2/gd;
  let m;
  while ((m = re.exec(masked))) {
    const [start, end] = m.indices[3];
    const spec = stringsKept.slice(start, end);
    if (!/^\.\.?\//.test(spec)) continue;
    const target = parseImportTarget(fromRel, spec);
    for (const b of parseImportClause(m[1])) {
      map.set(b.localName, {
        modulePath: target.modulePath,
        specExt: target.specExt,
        importedName: b.importedName,
      });
    }
  }
  return map;
}

/**
 * 表示用ディレクトリ名（title / subtitle にそのままホーム絶対パスを出さない）。
 * cwd 配下なら相対表記、外（`/Users/...` や `/tmp/...` など）なら末尾ディレクトリ名のみ返す。
 * @param {string} dir
 */
export function safeDisplayDir(dir) {
  const abs = path.resolve(dir);
  const base = path.basename(abs) || "src";
  const rel = path.relative(process.cwd(), abs);
  if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) {
    return base;
  }
  return rel.split(path.sep).join("/");
}

const DEFAULT_DECL_KEYWORDS = new Set([
  "class",
  "abstract",
  "interface",
  "enum",
  "function",
  "async",
  "declare",
  "new",
  "typeof",
  "void",
  "await",
]);

const DEFAULT_EXPORT_PREFIX_RE = /(?<!\.)\bexport\s+default\s+([A-Za-z_$][\w$]*)/g;
const CJS_DEFAULT_PREFIX_RE =
  /(?<!\.)\b(?:module\.exports|exports\.default)\s*=\s*([A-Za-z_$][\w$]*)/g;
const CONTINUATION_AFTER_NEWLINE_RE =
  /^\s*(?:\.|[?]\.|!=|[([`?:+\-*/%&|^=<>,]|(?:instanceof|in)\b)/;

/**
 * `export default Ident` / `module.exports = Ident` の直後位置 `pos` から文末までを走査し、
 * `Ident` が単独識別子（または純粋な `as` / `satisfies` 型アサーション付き識別子）として
 * 完結しているかを判定する。`Wrong.Sub`・`Wrong()`・`Wrong\n\n  .Sub`・
 * `Wrong as typeof Wrong && Actual` のような式継続は false を返す。
 */
function isStandaloneExportIdent(clean, pos) {
  const len = clean.length;
  const checkNewlineContinuation = (idx) => !CONTINUATION_AFTER_NEWLINE_RE.test(clean.slice(idx));

  const wsStart = pos;
  while (pos < len && (clean[pos] === " " || clean[pos] === "\t")) pos += 1;
  if (pos >= len || clean[pos] === ";") return true;
  if (clean[pos] === "\r" || clean[pos] === "\n") return checkNewlineContinuation(pos);
  if (pos === wsStart) return false;

  const firstKw = clean.slice(pos).match(/^(as|satisfies)\b/);
  if (!firstKw) return false;
  pos += firstKw[1].length;

  let depth = 0;
  let hasTypeToken = false;
  let justClosedAngle = false;

  while (pos < len) {
    if (
      clean.startsWith("&&", pos) ||
      clean.startsWith("||", pos) ||
      clean.startsWith("??", pos)
    ) {
      return false;
    }

    if (clean.startsWith("=>", pos)) {
      pos += 2;
      hasTypeToken = false;
      justClosedAngle = false;
      continue;
    }

    const ch = clean[pos];
    if (depth === 0) {
      if (ch === ";") return hasTypeToken;
      if (ch === "\r" || ch === "\n") {
        return hasTypeToken && checkNewlineContinuation(pos);
      }
      if (ch === " " || ch === "\t") {
        pos += 1;
        continue;
      }

      const prevCh = pos > 0 ? clean[pos - 1] : "";
      if (!/[.\w$]/.test(prevCh)) {
        const kw = clean.slice(pos).match(/^(as|satisfies)\b/);
        if (kw) {
          if (!hasTypeToken) return false;
          pos += kw[1].length;
          hasTypeToken = false;
          justClosedAngle = false;
          continue;
        }
        if (/^(?:instanceof|in)\b/.test(clean.slice(pos))) {
          return false;
        }
      }

      if (ch === "(") {
        if (hasTypeToken && !justClosedAngle) return false;
        depth = 1;
        hasTypeToken = true;
        justClosedAngle = false;
        pos += 1;
        continue;
      }
      if (ch === "[" || ch === "{" || ch === "<") {
        depth = 1;
        hasTypeToken = true;
        justClosedAngle = false;
        pos += 1;
        continue;
      }
      if ("+-*/%^?:,`=!>)]}".includes(ch)) {
        return false;
      }
      if (ch === "|" || ch === "&") {
        justClosedAngle = false;
        pos += 1;
        continue;
      }

      const identMatch = clean.slice(pos).match(/^[A-Za-z_$][\w$]*/);
      if (identMatch) {
        pos += identMatch[0].length;
        hasTypeToken = true;
        justClosedAngle = false;
        continue;
      }
      pos += 1;
      hasTypeToken = true;
      justClosedAngle = false;
      continue;
    }

    // depth > 0（型引数の `<...>`、タプル `[...]`、オブジェクト `{...}`、関数型 `(...)` 内部）
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") {
      depth -= 1;
      if (depth === 0 && ch === ">") justClosedAngle = true;
    }
    pos += 1;
  }

  return depth === 0 && hasTypeToken;
}

function extractStandaloneExportIdents(clean, prefixRe) {
  const out = [];
  prefixRe.lastIndex = 0;
  let m;
  while ((m = prefixRe.exec(clean))) {
    if (DEFAULT_DECL_KEYWORDS.has(m[1])) continue;
    if (isStandaloneExportIdent(clean, prefixRe.lastIndex)) {
      out.push(m[1]);
    }
  }
  return out;
}

/**
 * モジュール単位の export 情報を抽出する（クラスを持たない barrel モジュールも対象）。
 * `export { Other as default } from "./a"`・`export { Actual as Base }`・`export * from "./a"`・
 * `import { Actual } from "./a"; export { Actual as default }`・ES module の `export` 宣言の有無を収集し、
 * default 再エクスポート追跡・別名解決・非公開ローカル型への誤結線防止に使う。
 */
function extractModuleExportMeta(clean, stringsKept, relPath, importedSymbols) {
  const hasEsExport =
    /(?<!\.)\bexport\s+(?:default\b|type\b|declare\b|abstract\b|class\b|interface\b|enum\b|const\b|let\b|var\b|function\b|async\b|\{|\*)/.test(
      clean
    );
  let hasExplicitDefault = /(?<!\.)\bexport\s+default\b/.test(clean);
  let defaultLocalName = null;
  let defaultReExport = null;
  const namedLocalExports = new Map(); // exportedName -> localName
  const namedReExports = new Map(); // exportedName -> { target, importedName }
  const starReExports = [];

  for (const name of extractStandaloneExportIdents(clean, DEFAULT_EXPORT_PREFIX_RE)) {
    defaultLocalName = name;
  }
  let dm;

  const localExportRe = /(?<!\.)\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from\b)/g;
  while ((dm = localExportRe.exec(clean))) {
    for (const rawPart of dm[1].split(",")) {
      const part = rawPart.trim().replace(/^type\s+/, "").trim();
      if (!part) continue;
      const mAsDef = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+default$/);
      if (mAsDef) {
        hasExplicitDefault = true;
        defaultLocalName = mAsDef[1];
        continue;
      }
      const mAs = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (mAs) {
        namedLocalExports.set(mAs[2], mAs[1]);
        continue;
      }
      if (/^[A-Za-z_$][\w$]*$/.test(part)) {
        namedLocalExports.set(part, part);
      }
    }
  }

  const reExportRe = /(?<!\.)\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(["'`])([^"'`\r\n]+)\2/gd;
  while ((dm = reExportRe.exec(clean))) {
    const [start, end] = dm.indices[3];
    const spec = stringsKept.slice(start, end);
    const isRel = /^\.\.?\//.test(spec);
    const target = isRel ? parseImportTarget(relPath, spec) : null;
    for (const rawPart of dm[1].split(",")) {
      const part = rawPart.trim().replace(/^type\s+/, "").trim();
      if (!part) continue;
      const mAsDef = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+default$/);
      if (mAsDef) {
        hasExplicitDefault = true;
        if (target) defaultReExport = { target, importedName: mAsDef[1] };
        continue;
      }
      if (part === "default") {
        hasExplicitDefault = true;
        if (target) defaultReExport = { target, importedName: "default" };
        continue;
      }
      const mDefAs = part.match(/^default\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (mDefAs) {
        if (target) namedReExports.set(mDefAs[1], { target, importedName: "default" });
        continue;
      }
      const mAs = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (mAs) {
        if (target) namedReExports.set(mAs[2], { target, importedName: mAs[1] });
        continue;
      }
      if (/^[A-Za-z_$][\w$]*$/.test(part) && target) {
        namedReExports.set(part, { target, importedName: part });
      }
    }
  }

  const starRe = /(?<!\.)\bexport\s+\*\s+from\s*(["'`])([^"'`\r\n]+)\1/gd;
  while ((dm = starRe.exec(clean))) {
    const [start, end] = dm.indices[2];
    const spec = stringsKept.slice(start, end);
    if (/^\.\.?\//.test(spec)) {
      starReExports.push(parseImportTarget(relPath, spec));
    }
  }

  if (/(?<!\.)\b(?:module\.exports|exports\.default)\s*=(?!=)/.test(clean)) {
    hasExplicitDefault = true;
  }
  for (const name of extractStandaloneExportIdents(clean, CJS_DEFAULT_PREFIX_RE)) {
    hasExplicitDefault = true;
    defaultLocalName = name;
  }

  return {
    hasEsExport,
    hasExplicitDefault,
    defaultLocalName,
    defaultReExport,
    namedLocalExports,
    namedReExports,
    starReExports,
    importedSymbols,
  };
}

function scanSourceCode(code, relPath) {
  return scanFileDetails(code, relPath).types;
}

function scanFileDetails(code, relPath) {
  const clean = stripComments(code);
  const found = [];
  // 構文上の import 判定は clean（文字列中身が空白）で行い、一致範囲のパス文字列だけを stringsKept から切り出す。
  const stringsKept = stripComments(code, { keepStrings: true });
  const imports = extractRelativeImports(stringsKept, clean).map((spec) =>
    parseImportTarget(relPath, spec)
  );
  const importedSymbols = extractImportedSymbols(stringsKept, relPath, clean);
  const meta = extractModuleExportMeta(clean, stringsKept, relPath, importedSymbols);

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
      isDefault: /\bexport\s+default\b/.test(m[0]),
      isNamedExported: /^export\b/.test(m[0]) && !/^export\s+default\b/.test(m[0]),
      stereotype: abstractKw ? "abstract" : "default",
      file: relPath,
      imports,
      importedSymbols,
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
      isDefault: /\bexport\s+default\b/.test(m[0]),
      isNamedExported: /^export\b/.test(m[0]) && !/^export\s+default\b/.test(m[0]),
      stereotype: "interface",
      file: relPath,
      imports,
      importedSymbols,
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
      isDefault: /\bexport\s+default\b/.test(m[0]),
      isNamedExported: /^export\b/.test(m[0]) && !/^export\s+default\b/.test(m[0]),
      stereotype: "enum",
      file: relPath,
      imports,
      importedSymbols,
      attributes: members,
      methods: [],
      extends: [],
      implements: [],
    };
  });

  const defExports = new Set();
  for (const name of extractStandaloneExportIdents(clean, DEFAULT_EXPORT_PREFIX_RE)) {
    defExports.add(name);
  }
  const namedDefRe = /(?<!\.)\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from\b)/g;
  let dm;
  while ((dm = namedDefRe.exec(clean))) {
    for (const part of dm[1].split(",")) {
      const hit = part.trim().match(/^(?:type\s+)?([A-Za-z_$][\w$]*)\s+as\s+default$/);
      if (hit) defExports.add(hit[1]);
    }
  }
  for (const name of extractStandaloneExportIdents(clean, CJS_DEFAULT_PREFIX_RE)) {
    defExports.add(name);
  }
  if (defExports.size) {
    for (const item of found) {
      if (defExports.has(item.name)) item.isDefault = true;
    }
  }

  return { types: found, meta };
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
 * 走査対象のソースファイル一覧を返す。build-class の上書き防止検査も
 * この一覧と同一の一覧で照合する（別の簡易走査で食い違わないため）。
 * @param {string} dir
 */
export async function collectScannedSourceFiles(dir) {
  const root = path.resolve(dir);
  const files = [];
  await walkFiles(root, files);
  files.sort();
  return files;
}

/**
 * ディレクトリを再帰スキャンし、build-class.mjs 用 JSON spec を返す。
 * @param {string} dir
 * @param {{title?: string, subtitle?: string, packages?: boolean,
 *          files?: string[], scannedInputFiles?: string[]}} [opts]
 */
export async function scanDirectory(dir, opts = {}) {
  const root = path.resolve(dir);
  const files = opts.files
    ? opts.files.map((f) => path.resolve(f))
    : await collectScannedSourceFiles(dir);
  if (Array.isArray(opts.scannedInputFiles)) opts.scannedInputFiles.push(...files);

  const types = [];
  const relFiles = [];
  const fileMetaByRel = new Map();
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    relFiles.push(rel);
    const code = await fsp.readFile(file, "utf8");
    const { types: fileTypes, meta } = scanFileDetails(code, rel);
    fileMetaByRel.set(rel, meta);
    for (const t of fileTypes) {
      const pkg = path.posix.dirname(rel);
      t.package = pkg === "." ? undefined : pkg.split("/")[0];
      types.push(t);
    }
  }
  dedupeNames(types);

  // 参照名 → 型候補の対応（同名型が別ファイルに複数ある場合の解決用）。
  const byOrigName = new Map();
  for (const t of types) {
    const key = String(t.origName || t.name);
    if (!byOrigName.has(key)) byOrigName.set(key, []);
    byOrigName.get(key).push(t);
  }

  /**
   * `extends` / `implements` の参照名を型へ解決する。
   * 同じ名前の型が複数ファイルに定義されているときの優先順位:
   *   1. シンボル単位の import（拡張子指定の互換性と優先順位 `.mts > .mjs`, `.ts > .js` を守り、
   *      default re-export も追跡して解決する）
   *   2. 同じファイル内の宣言（別シンボルだけ import したモジュールの同名型に取り違えない）
   *   3. `import ... from "./..."` しているファイル内の宣言（名前が確定できない import 形）
   *   4. 走査順の最初の候補（それだけでは区別できないときの最後の手）
   */
  const stripExt = (f) => String(f).replace(MODULE_EXT_RE, "");
  const EXTENSIONLESS_EXT_PRIORITY = [
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
  ];
  const fileMatchesModule = (filePath, target) => {
    const modPath = typeof target === "string" ? target : target.modulePath;
    const specExt = typeof target === "string" ? "" : target.specExt || "";
    const base = stripExt(filePath);
    const fileExt = path.posix.extname(filePath).toLowerCase();
    if (specExt) {
      if (base !== modPath) return null;
      const order = COMPATIBLE_SOURCE_EXTS[specExt] || [specExt];
      const rank = order.indexOf(fileExt);
      return rank >= 0 ? { isIndex: 0, extRank: rank } : null;
    }
    let isIndex = -1;
    if (base === modPath) isIndex = 0;
    else if (base === `${modPath}/index`) isIndex = 1;
    if (isIndex < 0) return null;
    const idx = EXTENSIONLESS_EXT_PRIORITY.indexOf(fileExt);
    return { isIndex, extRank: idx >= 0 ? idx : 99 };
  };
  const compareMatchRank = (a, b) =>
    a.isIndex !== b.isIndex ? a.isIndex - b.isIndex : a.extRank - b.extRank;
  const resolveModuleFile = (target) => {
    let bestFile = null;
    let bestRank = null;
    for (const relFile of relFiles) {
      const rank = fileMatchesModule(relFile, target);
      if (!rank) continue;
      if (!bestRank || compareMatchRank(rank, bestRank) < 0) {
        bestFile = relFile;
        bestRank = rank;
      }
    }
    return bestFile;
  };
  /** ローカル識別子に対応する import 情報を厳密一致で引く（JS/TS は大文字小文字を区別する）。 */
  const findImportedSymbol = (from, ref) => {
    const map = from.importedSymbols;
    if (!map || typeof map.get !== "function") return null;
    return map.get(ref) || null;
  };
  const resolveTypeRef = (from, ref) => {
    const refName = String(ref);
    const imported = from.imports || [];
    const imp = findImportedSymbol(from, refName);
    const orig = (t) => String(t.origName || t.name);

    const resolveExportedSymbol = (
      relFile,
      exportName,
      active = new Set(),
      requireExplicitDefault = false,
      depth = 0,
      searchedAtDepth = new Map()
    ) => {
      const visitKey = `${relFile}\u0000${exportName}`;
      if (!relFile || depth > 16 || active.has(visitKey)) return null;
      const prevDepth = searchedAtDepth.get(visitKey);
      if (prevDepth !== undefined && prevDepth <= depth) return null;
      searchedAtDepth.set(visitKey, depth);
      active.add(visitKey);
      try {
        const meta = fileMetaByRel.get(relFile);
        const modTypes = types.filter((t) => t !== from && t.file === relFile);

        if (exportName === "default") {
          const directDef = modTypes.find((t) => t.isDefault);
          if (directDef) return directDef;
          if (meta?.defaultLocalName) {
            const localDecl = modTypes.find((t) => orig(t) === meta.defaultLocalName);
            if (localDecl) return localDecl;
            const localImp = meta?.importedSymbols?.get(meta.defaultLocalName);
            if (localImp?.modulePath) {
              const impFile = resolveModuleFile(localImp);
              return impFile
                ? resolveExportedSymbol(
                    impFile,
                    localImp.importedName,
                    active,
                    true,
                    depth + 1,
                    searchedAtDepth
                  )
                : null;
            }
          }
          if (meta?.defaultReExport) {
            const nextFile = resolveModuleFile(meta.defaultReExport.target);
            return nextFile
              ? resolveExportedSymbol(
                  nextFile,
                  meta.defaultReExport.importedName,
                  active,
                  true,
                  depth + 1,
                  searchedAtDepth
                )
              : null;
          }
          // `export { default } from ...` 先、または ES export を持つモジュールで
          // default 未定義のときは名前付きローカル型へフォールバックしない
          if (requireExplicitDefault || meta?.hasExplicitDefault || meta?.hasEsExport) {
            return null;
          }
          return (
            modTypes.find((t) => orig(t) === refName) ||
            (modTypes.length === 1 ? modTypes[0] : null)
          );
        }

        const localName = meta?.namedLocalExports?.get(exportName);
        if (localName) {
          const aliasHit = modTypes.find((t) => orig(t) === localName);
          if (aliasHit) return aliasHit;
          const localImp = meta?.importedSymbols?.get(localName);
          if (localImp?.modulePath) {
            const impFile = resolveModuleFile(localImp);
            if (impFile) {
              return resolveExportedSymbol(
                impFile,
                localImp.importedName,
                active,
                true,
                depth + 1,
                searchedAtDepth
              );
            }
          }
        }

        const reExp = meta?.namedReExports?.get(exportName);
        if (reExp) {
          const nextFile = resolveModuleFile(reExp.target);
          return nextFile
            ? resolveExportedSymbol(
                nextFile,
                reExp.importedName,
                active,
                true,
                depth + 1,
                searchedAtDepth
              )
            : null;
        }

        const direct = modTypes.find(
          (t) => orig(t) === exportName && (t.isNamedExported || !meta?.hasEsExport)
        );
        if (direct) return direct;

        for (const starTarget of meta?.starReExports || []) {
          const nextFile = resolveModuleFile(starTarget);
          if (!nextFile) continue;
          const starHit = resolveExportedSymbol(
            nextFile,
            exportName,
            active,
            true,
            depth + 1,
            searchedAtDepth
          );
          if (starHit) return starHit;
        }

        return null;
      } finally {
        active.delete(visitKey);
      }
    };

    // 1. シンボル単位の import 解決（別名 default import・別名 export・re-export を追跡して解決する）
    if (imp && imp.modulePath) {
      const targetFile = resolveModuleFile(imp);
      if (targetFile) {
        const resolved = resolveExportedSymbol(targetFile, imp.importedName);
        if (resolved) return resolved;
        if (
          fileMetaByRel.get(targetFile)?.hasEsExport ||
          (imp.importedName === "default" && fileMetaByRel.get(targetFile)?.hasExplicitDefault)
        ) {
          return null;
        }
      }
    }

    const lookupName =
      imp && imp.importedName && imp.importedName !== "default" ? imp.importedName : refName;
    const cands = byOrigName.get(lookupName) || [];
    const usable = cands.filter((x) => x !== from);
    if (!usable.length) return null;

    // 2. 同一ファイル内の宣言を、他の未指定 import 先モジュールより優先する
    const sameFile = usable.find((x) => x.file === from.file);
    if (sameFile) return sameFile;

    // 3. ファイル単位 import 先モジュール内の宣言（名前が確定できない import 形向け）
    if (imported.length) {
      let bestCand = null;
      let bestRank = null;
      for (const x of usable) {
        for (const mod of imported) {
          const rank = fileMatchesModule(x.file, mod);
          if (!rank) continue;
          if (!bestRank || compareMatchRank(rank, bestRank) < 0) {
            bestCand = x;
            bestRank = rank;
          }
        }
      }
      if (bestCand) return bestCand;
    }

    return usable[0];
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
      `scanned ${files.length} file(s) / ${classes.length} type(s) from ${safeDisplayDir(dir)}`,
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
  // 書き込み前の必須検査: `-o` にスキャン対象のソースを指定されたら、
  // 1 バイトも書く前に止まる（realpath と (dev, ino) で実体比較する）
  const outputs = [{ role: "-o / --output", value: values.output }];
  const inputEntries = [{ role: "--src-dir", value: values["src-dir"] }];
  const plannedFiles = await collectScannedSourceFiles(values["src-dir"]);
  assertOutputsDistinctFromInputs({
    inputs: [...inputEntries, { role: "スキャン対象（ソース）", files: plannedFiles }],
    outputs,
  });

  const scannedInputFiles = [];
  const spec = await scanDirectory(values["src-dir"], {
    packages: values.packages,
    title: values.title,
    subtitle: values.subtitle,
    files: plannedFiles,
    scannedInputFiles,
  });

  // 実際に走査した一覧で、書き込み直前にもう一度確かめる
  assertOutputsDistinctFromInputs({
    inputs: [...inputEntries, { role: "スキャン対象（ソース）", files: scannedInputFiles }],
    outputs,
  });

  const json = JSON.stringify(spec, null, 2) + "\n";
  if (values.output) {
    await fsp.mkdir(path.dirname(resolveWriteTarget(values.output)), { recursive: true });
    await writeFileAtomic(values.output, json);
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
