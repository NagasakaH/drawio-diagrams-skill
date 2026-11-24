#!/usr/bin/env node
/**
 * scan-schema.mjs
 * Pure Node.js scanner that parses SQL DDL (.sql) and Prisma schemas (.prisma)
 * and emits an ER diagram JSON spec (`tables` + `relations`).
 *
 * Supported SQL constructs:
 *   - CREATE TABLE (column PRIMARY KEY / NOT NULL / UNIQUE / inline REFERENCES)
 *   - table constraints: PRIMARY KEY (cols) / UNIQUE (cols) /
 *     FOREIGN KEY (cols) REFERENCES tbl (cols) / CONSTRAINT name ...
 *   - ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY / PRIMARY KEY / UNIQUE
 *   - COMMENT ON TABLE / COMMENT ON COLUMN (logical names & comments)
 *
 * Supported Prisma constructs:
 *   - model blocks with @id / @unique / @relation(fields: [...], references: [...])
 *   - composite @@id([...]) / @@unique([...]) / doc comments (///)
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { isDirectRun } from "./diagram-shared.mjs";

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function normalizeIdent(raw) {
  if (raw == null) return "";
  let s = String(raw).trim();
  s = s.replace(/;+$/, "");
  const parts = s.split(".").map((p) => p.trim().replace(/^"(.*)"$/, "$1").replace(/`(.*)`$/, "$1"));
  return parts[parts.length - 1];
}

/**
 * テーブル参照を **schema 修飾つきのまま**正規化する（列名の normalizeIdent とは違う）。
 * `sales.orders` と `audit.orders` は別テーブルとして区別しなければならいため、
 * 修飾があれば `schema.table` の形を保ち、クォートだけ外す。
 * （database.schema.table のような 3 段修飾は最後の 2 段を保持する）
 */
function normalizeQualified(raw) {
  if (raw == null) return "";
  let s = String(raw).trim();
  s = s.replace(/;+$/, "");
  const parts = s
    .split(".")
    .map((p) => p.trim().replace(/^"(.*)"$/, "$1").replace(/`(.*)`$/, "$1"))
    .filter(Boolean);
  if (!parts.length) return "";
  return parts.slice(-2).join(".");
}

/**
 * 列の集合が「単独で一意」かどうかを判定する。
 *
 * 判定規則は**部分集合規則**: 主キー集合または UNIQUE 制約集合のうち、
 * 1 つでも `U` があって `U.length > 0` かつ FK 列集合 `F` の部分集合（`U ⊆ F`）なら、
 * FK 列集合は一意性を保証する（親から見て子が高々 1 件）→ true。
 *
 * - 複合 PK `(a, c)` + FK `(a)`: `U={a,c} ⊄ {a}` → false（子は N 件あり得る）
 * - 単独 `UNIQUE(a)` + FK `(a, b)`: `U={a} ⊆ {a,b}` → true（子は 0..1）
 */
function isUniqueColumnSet(columnSets, columns) {
  const fkSet = new Set(columns);
  if (fkSet.size === 0) return false;
  return columnSets.some((set) => {
    const u = [...new Set(set)];
    return u.length > 0 && u.every((c) => fkSet.has(c));
  });
}

/**
 * Crow's Foot の基数ラベルを組み立てる。
 *
 * - 親側（子から見た親の存在性）: FK 列がすべて NOT NULL なら `1`、
 *   いずれかが NULL 許容なら `0..1`
 * - 子側（親から見た子の個数）: FK 列集合が一意制約（単独 PK / UNIQUE）なら上限 `1`、
 *   そうでなければ上限 `N`。下限は常に `0`（例: 住所が 0 件のユーザーも合法）
 */
function buildCardinality({ columns, columnSets, allNotNull }) {
  const parentSide = allNotNull ? "1" : "0..1";
  const childSide = isUniqueColumnSet(columnSets, columns) ? "0..1" : "0..N";
  return `${parentSide}:${childSide}`;
}

function splitIdentList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((s) => normalizeIdent(s))
    .filter(Boolean);
}

/** Remove `--` line comments and /* *\/ block comments, respecting quotes. */
function stripSqlComments(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        out += sql[i];
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === "-" && c2 === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      out += " ";
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Return the balanced (...) content starting at the "(" near index. */
function extractBalanced(text, openParenIndex) {
  let depth = 0;
  let inQuote = null;
  for (let i = openParenIndex; i < text.length; i += 1) {
    const c = text[i];
    if (inQuote) {
      if (c === inQuote) {
        if (text[i + 1] === inQuote) i += 1;
        else inQuote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      inQuote = c;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(openParenIndex + 1, i);
    }
  }
  return null;
}

/** Split a string by commas at paren depth 0 (respecting quotes). */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let inQuote = null;
  let cur = "";
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (inQuote) {
      cur += c;
      if (c === inQuote) {
        if (body[i + 1] === inQuote) {
          cur += body[i + 1];
          i += 1;
        } else inQuote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      inQuote = c;
      cur += c;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const TYPE_STOP_WORDS = new Set([
  "PRIMARY", "NOT", "NULL", "UNIQUE", "CHECK", "REFERENCES", "CONSTRAINT",
  "DEFAULT", "GENERATED", "COLLATE", "COMMENT", "IDENTITY", "AUTO_INCREMENT",
  "AS", "STORED", "VIRTUAL",
]);

/**
 * Split a raw column definition into `{ name, type, rest }`.
 * `type` accumulates tokens until a constraint keyword appears.
 */
function splitColumnDef(part) {
  const nameMatch = part.match(/^"([^"]+)"\s*/);
  let name;
  let rest;
  if (nameMatch) {
    name = nameMatch[1];
    rest = part.slice(nameMatch[0].length);
  } else {
    const m = part.match(/^([A-Za-z_][\w$]*)\s+/);
    if (!m) return null;
    name = m[1];
    rest = part.slice(m[0].length);
  }

  const tokens = [];
  let depth = 0;
  let inQuote = null;
  let cur = "";
  let stop = false;
  const flush = () => {
    if (cur.trim()) tokens.push(cur.trim());
    cur = "";
  };
  for (let i = 0; i < rest.length && !stop; i += 1) {
    const c = rest[i];
    if (inQuote) {
      cur += c;
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      inQuote = c;
      cur += c;
      continue;
    }
    if (c === "(") {
      depth += 1;
      cur += c;
      continue;
    }
    if (c === ")") {
      depth -= 1;
      cur += c;
      continue;
    }
    if (/\s/.test(c)) {
      flush();
      if (depth === 0) {
        const nextWord = rest
          .slice(i + 1)
          .match(/^([A-Za-z_][\w$]*)/);
        if (nextWord && TYPE_STOP_WORDS.has(nextWord[1].toUpperCase())) stop = true;
        else if (nextWord && nextWord[1].toUpperCase() === "NULL") stop = true;
      }
      continue;
    }
    cur += c;
  }
  flush();
  const type = tokens.join(" ").trim();
  const typeLen = type.length;
  // Locate `rest` after the consumed type tokens for constraint regexes.
  const restAfterType = rest.slice(rest.toLowerCase().indexOf(type.toLowerCase()) + typeLen);
  return { name, type: type || "?", rest: restAfterType };
}

// ---------------------------------------------------------------------------
// SQL (PostgreSQL / MySQL / ANSI) parser
// ---------------------------------------------------------------------------

function parseSql(sql, sourceName) {
  const clean = stripSqlComments(sql);
  const tables = new Map();
  const fkRaw = [];
  const pkExtra = [];
  const uniqueExtra = [];

  const getTable = (name) => {
    if (!tables.has(name)) {
      tables.set(name, { name, columns: [], _byName: new Map(), _uniqueSets: [], _pkSets: [] });
    }
    return tables.get(name);
  };
  // COMMENT ON などは修飾なしで書かれることがある: 修飾名 → 末尾名の一意一致の順で引く。
  const findTable = (raw) => {
    const q = normalizeQualified(raw);
    if (tables.has(q)) return tables.get(q);
    const base = normalizeIdent(raw);
    const cands = [...tables.values()].filter((t) => normalizeIdent(t.name) === base);
    return cands.length === 1 ? cands[0] : null;
  };
  const addColumn = (table, col) => {
    if (!table._byName.has(col.name)) {
      table._byName.set(col.name, col);
      table.columns.push(col);
    }
    return table._byName.get(col.name);
  };

  // CREATE TABLE
  const createRe = /CREATE\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+|EXTERNAL\s+)*TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"?[\w$]+"?\.)?"?[\w$]+"?)/gi;
  let m;
  while ((m = createRe.exec(clean)) !== null) {
    const tableName = normalizeQualified(m[1]);
    const openIdx = clean.indexOf("(", m.index + m[0].length);
    if (openIdx < 0) continue;
    const body = extractBalanced(clean, openIdx);
    if (body == null) continue;
    createRe.lastIndex = openIdx + (body ? body.length + 2 : 0);

    const table = getTable(tableName);
    table.source = sourceName;

    for (const part of splitTopLevel(body)) {
      const head = part.replace(/^\s*CONSTRAINT\s+"?[\w$]+"?\s+/i, "");
      const headUp = head.toUpperCase();

      if (headUp.startsWith("PRIMARY KEY")) {
        const cols = splitIdentList(head.match(/\(([^)]*)\)/)?.[1]);
        pkExtra.push({ table: tableName, columns: cols });
        continue;
      }
      if (headUp.startsWith("UNIQUE")) {
        const cols = splitIdentList(head.match(/\(([^)]*)\)/)?.[1]);
        uniqueExtra.push({ table: tableName, columns: cols });
        continue;
      }
      if (headUp.startsWith("FOREIGN KEY")) {
        const cols = splitIdentList(head.match(/\(([^)]*)\)/)?.[1]);
        const ref = head.match(
          /REFERENCES\s+((?:"?[\w$]+"?\.)?"?[\w$]+"?)\s*(?:\(([^)]*)\))?/i
        );
        if (ref && cols.length) {
          fkRaw.push({
            table: tableName,
            columns: cols,
            parent: normalizeQualified(ref[1]),
            parentColumns: splitIdentList(ref[2]),
          });
        }
        continue;
      }
      if (
        headUp.startsWith("CHECK") ||
        headUp.startsWith("EXCLUDE") ||
        headUp.startsWith("LIKE")
      ) {
        continue;
      }

      const colDef = splitColumnDef(part);
      if (!colDef) continue;
      const rest = colDef.rest;
      const col = addColumn(table, {
        name: colDef.name,
        type: colDef.type,
        pk: /\bPRIMARY\s+KEY\b/i.test(rest),
        fk: false,
        unique: /\bUNIQUE\b/i.test(rest),
        notNull: /\bNOT\s+NULL\b/i.test(rest),
        comment: "",
      });
      if (/\bPRIMARY\s+KEY\b/i.test(rest)) {
        col.notNull = true;
        table._pkSets.push([colDef.name]);
      }
      if (/\bUNIQUE\b/i.test(rest)) {
        col.unique = true;
        table._uniqueSets.push([colDef.name]);
      }
      const ref = rest.match(
        /\bREFERENCES\s+((?:"?[\w$]+"?\.)?"?[\w$]+"?)\s*(?:\(([^)]*)\))?/i
      );
      if (ref) {
        col.fk = true;
        fkRaw.push({
          table: tableName,
          columns: [colDef.name],
          parent: normalizeQualified(ref[1]),
          parentColumns: splitIdentList(ref[2]),
        });
      }
    }
  }

  // ALTER TABLE ... ADD CONSTRAINT ... (FOREIGN KEY / PRIMARY KEY / UNIQUE)
  const alterRe =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?((?:"?[\w$]+"?\.)?"?[\w$]+"?)\s+ADD\s+(?:CONSTRAINT\s+"?[\w$]+"?\s+)?(FOREIGN\s+KEY|PRIMARY\s+KEY|UNIQUE)\s*\(([^)]*)\)(?:\s*REFERENCES\s+((?:"?[\w$]+"?\.)?"?[\w$]+"?)\s*(?:\(([^)]*)\))?)?/gi;
  while ((m = alterRe.exec(clean)) !== null) {
    const tableName = normalizeQualified(m[1]);
    const kind = m[2].toUpperCase().replace(/\s+/g, " ");
    const cols = splitIdentList(m[3]);
    if (kind === "FOREIGN KEY") {
      fkRaw.push({
        table: tableName,
        columns: cols,
        parent: normalizeQualified(m[4]),
        parentColumns: splitIdentList(m[5]),
      });
    } else if (kind === "PRIMARY KEY") {
      pkExtra.push({ table: tableName, columns: cols });
    } else if (kind === "UNIQUE") {
      uniqueExtra.push({ table: tableName, columns: cols });
    }
  }

  // COMMENT ON TABLE / COLUMN (PostgreSQL logical names)
  const commentTableRe =
    /COMMENT\s+ON\s+TABLE\s+((?:"?[\w$]+"?\.)?"?[\w$]+"?)\s+IS\s+(?:NULL|'((?:[^']|'')*)')/gi;
  while ((m = commentTableRe.exec(clean)) !== null) {
    const t = findTable(m[1]);
    if (t && m[2]) t.displayName = m[2].replace(/''/g, "'");
  }
  const commentColRe =
    /COMMENT\s+ON\s+COLUMN\s+((?:"?[\w$]+"?\.)?"?[\w$]+"?)\.("?[\w$]+"?)\s+IS\s+(?:NULL|'((?:[^']|'')*)')/gi;
  while ((m = commentColRe.exec(clean)) !== null) {
    const t = findTable(m[1]);
    if (t) {
      const col = t._byName.get(normalizeIdent(m[2]));
      if (col && m[3]) col.comment = m[3].replace(/''/g, "'");
    }
  }

  // Apply keys & FK flags
  for (const pk of pkExtra) {
    const t = getTable(pk.table);
    if (pk.columns.length) t._pkSets.push(pk.columns);
    for (const cname of pk.columns) {
      const col = t._byName.get(cname) || addColumn(t, { name: cname, type: "?", pk: false, fk: false, unique: false, notNull: true, comment: "" });
      col.pk = true;
      col.notNull = true;
    }
  }
  for (const uq of uniqueExtra) {
    const t = getTable(uq.table);
    if (uq.columns.length) t._uniqueSets.push(uq.columns);
    if (uq.columns.length === 1) {
      const col = t._byName.get(uq.columns[0]);
      if (col) col.unique = true;
    } else {
      for (const cname of uq.columns) {
        const col = t._byName.get(cname);
        if (col) col.compositeUnique = true;
      }
    }
  }

  const relations = [];
  for (const fk of fkRaw) {
    const t = getTable(fk.table);
    for (const cname of fk.columns) {
      const col = t._byName.get(cname) || addColumn(t, { name: cname, type: "?", pk: false, fk: false, unique: false, notNull: false, comment: "" });
      col.fk = true;
    }
    const allNotNull = fk.columns.every((cname) => t._byName.get(cname)?.notNull);
    const cardinality = buildCardinality({
      columns: fk.columns,
      columnSets: [...t._pkSets, ...t._uniqueSets],
      allNotNull,
    });

    const exists = relations.some(
      (r) => r.to === fk.table && r.from === fk.parent && r.fromColumns.join(",") === fk.parentColumns.join(",") && r.toColumns.join(",") === fk.columns.join(",")
    );
    if (exists) continue;
    relations.push({
      id: `rel_${relations.length + 1}`,
      from: fk.parent,
      to: fk.table,
      fromColumns: fk.parentColumns.length ? fk.parentColumns : ["id"],
      toColumns: fk.columns,
      label: fk.columns.join(" + "),
      cardinality,
    });
  }

  for (const t of tables.values()) {
    delete t._byName;
    delete t._uniqueSets;
    delete t._pkSets;
  }
  return { tables: [...tables.values()], relations };
}

// ---------------------------------------------------------------------------
// Prisma schema parser
// ---------------------------------------------------------------------------

/**
 * Prisma スキーマを解析する。複数ファイルの内容を 1 本のテキストに結合して
 * 渡すと、Pass 1 で全ファイルの model / enum 定義を収集し、Pass 2 で
 * `@relation` をファイル横断で解決する（別ファイルの model を参照していても解決できる）。
 */
function parsePrisma(text, sourceName) {
  const tables = new Map();
  const relations = [];

  const getTable = (name) => {
    if (!tables.has(name)) {
      tables.set(name, {
        name,
        columns: [],
        _byName: new Map(),
        _uniqueSets: [],
        _pkSets: [],
        source: sourceName,
      });
    }
    return tables.get(name);
  };

  const modelRe = /\n[ \t]*(model|type)\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  const textWithSentinel = `\n${text}`;

  // First pass: collect declared model names so enum field types are not
  // mistaken for relation references.
  const modelNames = new Set();
  let pre;
  modelRe.lastIndex = 0;
  while ((pre = modelRe.exec(textWithSentinel)) !== null) {
    if (pre[1] === "model") modelNames.add(pre[2]);
  }

  let m;
  modelRe.lastIndex = 0;
  while ((m = modelRe.exec(textWithSentinel)) !== null) {
    const modelName = m[2];
    const body = m[3];
    const table = getTable(modelName);

    const compositePk = [];
    const compositeUq = [];
    const pendingRels = [];

    const lines = body.split(/\r?\n/);
    for (let rawLine of lines) {
      const comment = rawLine.match(/^\s*\/\/\/\s*(.*)$/);
      rawLine = rawLine.replace(/\/\/(?!!).*$/, "").trim();
      if (!rawLine) continue;

      let lm = rawLine.match(/^@@id\(\[([^\]]*)\]\)/);
      if (lm) {
        const cols = splitIdentList(lm[1]);
        compositePk.push(...cols);
        if (cols.length) table._pkSets.push(cols);
        continue;
      }
      lm = rawLine.match(/^@@unique\(\[([^\]]*)\]\)/);
      if (lm) {
        const cols = splitIdentList(lm[1]);
        compositeUq.push(...cols);
        if (cols.length) table._uniqueSets.push(cols);
        continue;
      }
      if (/^@@/.test(rawLine)) continue;

      const fm = rawLine.match(/^(\w+)\s+(\w+)(\?)?(\[\])?\s*([\s\S]*)$/);
      if (!fm) continue;
      const [, fieldName, fieldType, optional, arrayMark, attrs = ""] = fm;
      const isId = /@id\b/.test(attrs);
      const isUnique = /@unique\b/.test(attrs);
      const relMatch = attrs.match(/@relation\(([^)]*(?:\([^)]*\)[^)]*)*)\)/);
      const relFields = relMatch ? splitIdentList(relMatch[1].match(/fields\s*:\s*\[([^\]]*)\]/)?.[1] ?? "") : [];
      const relRefs = relMatch ? splitIdentList(relMatch[1].match(/references\s*:\s*\[([^\]]*)\]/)?.[1] ?? "") : [];
      const relName = relMatch ? relMatch[1].match(/name\s*:\s*"([^"]*)"/)?.[1] ?? "" : "";

      const isModelRef = modelNames.has(fieldType);

      const col = {
        name: fieldName,
        type: arrayMark ? `${fieldType}[]` : fieldType,
        pk: isId,
        fk: relFields.includes(fieldName),
        unique: isUnique,
        notNull: !optional && !arrayMark && !isModelRef,
        comment: comment ? comment[1].trim() : "",
      };
      if (isId) col.notNull = true;
      if (isId) table._pkSets.push([fieldName]);
      if (isUnique) table._uniqueSets.push([fieldName]);
      if (!table._byName.has(fieldName)) {
        table.columns.push(col);
        table._byName.set(fieldName, col);
      }

      if (isModelRef && relFields.length > 0 && !arrayMark) {
        for (const f of relFields) {
          const fc = table._byName.get(f);
          if (fc) fc.fk = true;
        }
        pendingRels.push({
          from: fieldType,
          to: modelName,
          fromColumns: relRefs.length ? relRefs : ["id"],
          toColumns: relFields,
          label: relName || fieldName,
        });
      }
    }

    for (const cname of compositePk) {
      const col = table._byName.get(cname);
      if (col) {
        col.pk = true;
        col.notNull = true;
      }
    }
    if (compositeUq.length === 1) {
      const col = table._byName.get(compositeUq[0]);
      if (col) col.unique = true;
    } else if (compositeUq.length > 1) {
      for (const cname of compositeUq) {
        const col = table._byName.get(cname);
        if (col) col.compositeUnique = true;
      }
    }

    // Resolve cardinality after all column flags are final.
    for (const pr of pendingRels) {
      const allNotNull = pr.toColumns.every((f) => {
        const fc = table._byName.get(f);
        return fc && fc.notNull;
      });
      const cardinality = buildCardinality({
        columns: pr.toColumns,
        columnSets: [...table._pkSets, ...table._uniqueSets],
        allNotNull,
      });
      relations.push({ id: `rel_${relations.length + 1}`, ...pr, cardinality });
    }
  }

  // Drop relations whose parent model was never declared
  const known = new Set(tables.keys());
  const keptRelations = relations.filter((r) => known.has(r.from) && known.has(r.to));

  for (const t of tables.values()) {
    delete t._byName;
    delete t._uniqueSets;
    delete t._pkSets;
  }
  return { tables: [...tables.values()], relations: keptRelations };
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * 入力ファイル収集。
 *
 * - 明示的に渡されたパス（root）は symlink でも追跡する（利用者の意図）
 * - ディレクトリ内のchild が symlink の場合は**既定でスキップ**する。
 *   外部ディレクトリへの越境や循環 symlink でのクラッシュを防ぐため。
 *   追跡したいときは `--follow-symlinks` を使う（その場合も訪問済み実体パスで循環を守る）。
 */
async function collectInputFiles(inputs, options = {}) {
  const followSymlinks = Boolean(options.followSymlinks);
  const files = [];
  const visitedDirs = new Set();

  for (const input of inputs) {
    const rootResolved = path.resolve(input);
    const rootReal = await fs.realpath(rootResolved).catch(() => rootResolved);

    const walk = async (p, isRoot) => {
      let st;
      try {
        st = isRoot || followSymlinks ? await fs.stat(p) : await fs.lstat(p);
      } catch (err) {
        // ENOENT・ELOOP（循環 symlink）・権限エラーなども含め、ここで走査全体を落とさない
        const code = err && err.code ? err.code : err && err.message;
        console.warn(`[warn] 読み込めないためスキップ: ${p} (${code})`);
        return;
      }
      if (st.isSymbolicLink()) return; // 非追跡時の symlink（切れたリンクも含む）
      // 境界ガード: 走査ルートの実体パスの外へ解決されるものは --follow-symlinks でも追わない
      if (!isRoot) {
        const real = await fs.realpath(p).catch(() => null);
        if (real && real !== rootReal && !real.startsWith(rootReal + path.sep)) {
          console.warn(`[warn] 走査ルートの外に解決されるためスキップ: ${p} -> ${real}`);
          return;
        }
      }
      if (st.isDirectory()) {
        const realDir = await fs.realpath(p).catch(() => path.resolve(p));
        if (visitedDirs.has(realDir)) return; // 循環 symlink 対策
        visitedDirs.add(realDir);
        let entries;
        try {
          entries = await fs.readdir(p, { withFileTypes: true });
        } catch (err) {
          console.warn(`[warn] ディレクトリを読み込めないためスキップ: ${p} (${err.message})`);
          return;
        }
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "migrations") continue;
          if (!isRoot && !followSymlinks && e.isSymbolicLink()) {
            console.warn(`[warn] symlink は既定でスキップ（--follow-symlinks で追跡可）: ${path.join(p, e.name)}`);
            continue;
          }
          await walk(path.join(p, e.name), false);
        }
      } else if (/\.(sql|prisma)$/i.test(p)) {
        files.push(p);
      }
    };
    await walk(rootResolved, true);
  }
  return files;
}

/**
 * Scan .sql / .prisma files (or directories containing them) into an ER spec.
 */
export async function scanSchemaFiles(inputs, options = {}) {
  const files = await collectInputFiles(inputs, options);
  if (files.length === 0) {
    throw new Error(`No .sql / .prisma files found in: ${inputs.join(", ")}`);
  }

  const tables = [];
  const tableIndex = new Map();
  const relations = [];
  const sources = [];

  const mergeParsed = (parsed) => {
    for (const t of parsed.tables) {
      if (tableIndex.has(t.name)) {
        const existing = tableIndex.get(t.name);
        const known = new Set(existing.columns.map((c) => c.name));
        for (const c of t.columns) {
          if (!known.has(c.name)) existing.columns.push(c);
        }
        if (!existing.displayName && t.displayName) existing.displayName = t.displayName;
      } else {
        tableIndex.set(t.name, t);
        tables.push(t);
      }
    }
    for (const r of parsed.relations) {
      if (relations.some((x) => x.from === r.from && x.to === r.to && x.toColumns.join(",") === r.toColumns.join(","))) continue;
      relations.push(r);
    }
  };

  const prismaTexts = [];
  const prismaSources = [];
  const modelSource = new Map();

  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    const sourceName = path.basename(file);
    sources.push(sourceName);
    if (/\.prisma$/i.test(file)) {
      prismaTexts.push(text);
      prismaSources.push(sourceName);
      const declRe = /\n[ \t]*(?:model|type)\s+(\w+)\s*\{/g;
      let g;
      while ((g = declRe.exec(`\n${text}`)) !== null) {
        if (!modelSource.has(g[1])) modelSource.set(g[1], sourceName);
      }
      continue;
    }
    mergeParsed(parseSql(text, sourceName));
  }

  if (prismaTexts.length > 0) {
    // Prisma は全ファイルを 1 本に結合して解析する（Pass 1: 全 model/enum を収集、
    // Pass 2: @relation をファイル横断で解決）。model の source は定義ファイル名を復元する。
    const parsed = parsePrisma(prismaTexts.join("\n\n"), prismaSources.join(", "));
    for (const t of parsed.tables) {
      if (modelSource.has(t.name)) t.source = modelSource.get(t.name);
    }
    mergeParsed(parsed);
  }

  // Keep only relations between known tables
  const validRelations = relations.filter((r) => tableIndex.has(r.from) && tableIndex.has(r.to));
  validRelations.forEach((r, i) => {
    r.id = `rel_${i + 1}`;
  });

  return {
    title: options.title || null,
    subtitle: options.subtitle || null,
    sources,
    tables,
    relations: validRelations,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP_TEXT = `
scan-schema.mjs - SQL DDL / Prisma -> ER JSON spec scanner (zero dependency)

Usage:
  node scripts/scan-schema.mjs <file-or-dir> [...more] [-o schema.json]

Options:
  -o, --output <path>   Output JSON spec path (default: stdout)
      --title <text>    Override diagram title in the spec
      --subtitle <text> Override diagram subtitle in the spec
      --follow-symlinks Trace symbolic links inside scanned directories (off by default)
  -h, --help            Show help
`.trim();

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      output: { type: "string", short: "o" },
      title: { type: "string" },
      subtitle: { type: "string" },
      "follow-symlinks": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP_TEXT);
    process.exit(values.help ? 0 : 1);
  }

  const spec = await scanSchemaFiles(positionals, {
    title: values.title,
    subtitle: values.subtitle,
    followSymlinks: values["follow-symlinks"],
  });

  const json = JSON.stringify(spec, null, 2);
  if (values.output) {
    await fs.mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
    await fs.writeFile(values.output, json, "utf8");
    console.log(
      `Scanned ${spec.tables.length} tables / ${spec.relations.length} relations -> ${values.output}`
    );
  } else {
    console.log(json);
  }
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => {
    console.error("Error:", err.message || err);
    process.exit(1);
  });
}
