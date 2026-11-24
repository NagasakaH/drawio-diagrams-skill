/**
 * diagram-shared.mjs
 * 各ビルダー／スキャナで共有する小さなユーティリティ（依存は Node.js 標準モジュールのみ）。
 *
 * - createCellIdMap(): 元 ID → 一意な内部セル ID の対応表
 *   （日本語 ID や記号違いの ID が同じ正規形に潰れて衝突するのを防ぐ）
 * - isDirectRun(): import 時（`node -` / stdin・実体のないエントリ）でも落ちない直接実行判定
 * - inspectXmlCells(): 生成 XML のセル ID 一意性・エッジ／parent 参照先・NaN の検査
 * - expandInputPaths() / assertOutputsDistinctFromInputs():
 *   最初の書き込みより前に「出力先が入力ファイルや別の出力先と同一」を検出して止める
 */
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** XML 属性値・テキストに埋め込む文字列をエスケープする。 */
export function escapeXml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** セル ID に使える ASCII 文字だけを残す（それ以外は `_`）。 */
function sanitizeIdPart(raw) {
  const s = String(raw ?? "").replace(/[^A-Za-z0-9_-]+/g, "_");
  return s.length ? s : "x";
}

/**
 * 元 ID を 1 本に定まる一意な XML セル ID へ写す対応表を作る。
 *
 * - 正規形が同じになる別 ID（`a.b` と `a/b`、`注文` と `顧客` など）には
 *   連番 `_2`, `_3` を付けて区別する
 * - 登録順（＝spec の宣言順）で割り当てるため決定論的
 * - `protect()` で子セルに使う接尾語を予約し、本体 ID との子セル名衝突も避ける
 *
 * 使い方:
 *   const ids = createCellIdMap();
 *   for (const n of nodes) n._cellId = ids.id("c4", n.id);
 *   ids.protect(n._cellId, ["lbl"]);
 *   ... ids.id("c4", rel.from)   // 本体・エッジ両端で同じ ID を共有
 */
export function createCellIdMap() {
  const map = new Map();
  const used = new Set();

  const claim = (candidate) => {
    let id = candidate;
    let i = 2;
    while (used.has(id)) id = `${candidate}_${i++}`;
    used.add(id);
    return id;
  };

  const keyOf = (prefix, raw) => `${prefix}\u0000${String(raw ?? "")}`;

  return {
    /** 元 ID に対応するセル ID を返す（未登録なら採番して登録する）。 */
    id(prefix, raw) {
      const key = keyOf(prefix, raw);
      if (map.has(key)) return map.get(key);
      const assigned = claim(`${prefix}-${sanitizeIdPart(raw)}`);
      map.set(key, assigned);
      return assigned;
    },
    /** 元 ID が登録済みか。 */
    has(prefix, raw) {
      return map.has(keyOf(prefix, raw));
    },
    /** 接頭辞なしで一意な名称を割り当する（`card_<name>` の `<name>` 部分など）。 */
    unique(raw) {
      const key = keyOf("", raw);
      if (map.has(key)) return map.get(key);
      const assigned = claim(sanitizeIdPart(raw));
      map.set(key, assigned);
      return assigned;
    },
    /** `parentId` の子セル名として使う接尾語を予約する（別の元 ID に使われない）。 */
    protect(parentId, suffixes) {
      for (const s of suffixes) used.add(`${parentId}-${s}`);
    },
    /**
     * 親セル `parentId` の子セル ID を一意に採番する。
     * 候補 `${parentId}~${suffix}` の `~` は sanitizeIdPart() が生成しない文字なので、
     * どんな元 ID（`A-attrs` や `A~attrs` など）とも衝突しない。同じ (親, 接尾語)
     * には常に同じ ID を返す（メモ化）。
     */
    child(parentId, suffix) {
      const key = keyOf(`\u0000child:${parentId}`, suffix);
      if (map.has(key)) return map.get(key);
      const assigned = claim(`${parentId}~${sanitizeIdPart(suffix)}`);
      map.set(key, assigned);
      return assigned;
    },
    /** キャンバス固定要素（見出し・凡例・フッター）の ID を予約付きで割り当てる。 */
    fixed(literal) {
      const key = keyOf("\u0000fixed", literal);
      if (map.has(key)) return map.get(key);
      const assigned = claim(sanitizeIdPart(literal));
      map.set(key, assigned);
      return assigned;
    },
    /** 採番済みのセル ID 集合（検査用）。 */
    allocated() {
      return new Set(used);
    },
  };
}

/**
 * 入力・出力パスの重複検査。`--spec` 等の入力・`--xml-out`・`--output` が
 * 正規化後に同一ファイルを指していたら人間が読めるエラーを投げる（呼び出し側で exit 1）。
 * @param {Array<{role: string, value?: string|null}>} entries
 */
export function assertDistinctPaths(entries) {
  const seen = new Map();
  for (const { role, value } of entries) {
    if (!value) continue;
    const abs = path.resolve(value);
    const prev = seen.get(abs);
    if (prev) {
      throw new Error(
        `入出力パスが衝突しています: ${prev} と ${role} が同一のファイルです (${value})。` +
          `それぞれの出力先を別々にしてください。`
      );
    }
    seen.set(abs, role);
  }
}

const CLASH_SKIP_DIRS = new Set(["node_modules", ".git", ".terraform", "dist", "out"]);

/**
 * 入力として指定されたパス（ファイルまたはディレクトリ）を、
 * 「スキャナが実際に読み取り得るファイル一覧」へ展開する。
 *
 * - ディレクトリは再帰的に走査し、`extensionRe` に一致するファイルを列挙する
 * - 存在しないパス・読み取れないディレクトリは落とさず、指定された絶対パスそのまま残す
 *   （照合だけで使いたいので、走査失敗をエラーにしない）
 * @param {string[]} inputs 指定された入力パス（未解決可）
 * @param {RegExp|null} extensionRe ディレクトリ走査時に拾うファイル名の正規表現
 * @returns {Promise<{files: string[], roots: string[]}>} いずれも path.resolve() 済み
 */
export async function expandInputPaths(inputs, extensionRe = null) {
  const files = [];
  const roots = [];
  const visitedDirs = new Set();

  for (const raw of inputs) {
    if (!raw) continue;
    const abs = path.resolve(raw);
    roots.push(abs);
    let st = null;
    try {
      st = await fsp.stat(abs);
    } catch {
      files.push(abs); // 存在しない入力でも指定パスとしては照合する
      continue;
    }
    if (!st.isDirectory()) {
      files.push(abs);
      continue;
    }
    const stack = [abs];
    while (stack.length > 0) {
      const dir = stack.pop();
      const real = await fsp.realpath(dir).catch(() => dir);
      if (visitedDirs.has(real)) continue; // 循環 symlink 対策
      visitedDirs.add(real);
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        const child = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name.startsWith(".") || CLASH_SKIP_DIRS.has(ent.name)) continue;
          stack.push(child);
        } else if (!extensionRe || extensionRe.test(ent.name)) {
          files.push(child);
        }
      }
    }
  }
  return { files: files.map((f) => path.resolve(f)), roots };
}

/**
 * 書き込みを行う前の「上書き防止」検査。
 *
 * 出力パス（`--json-out` / `--xml-out` / `--output`）が
 *   1. 別の出力パスと `path.resolve()` 後に一致、または
 *   2. 入力ファイル（スキャナが読み取るファイル）と一致、または
 *   3. 入力として指定されたパスそのものと一致
 * のいずれかなら、1 バイトも書き込む前に人間が読めるエラーを投げる（呼び出し側で exit 1）。
 *
 * @param {{
 *   inputs: Array<{role: string, value: string, files?: string[]}>,
 *   outputs: Array<{role: string, value?: string|null}>,
 * }} opts
 */
export function assertOutputsDistinctFromInputs({ inputs = [], outputs = [] }) {
  const inputOwners = new Map(); // abs -> 説明
  const inputDirs = []; // { abs, role }

  for (const entry of inputs) {
    if (!entry || !entry.value) continue;
    const abs = path.resolve(entry.value);
    inputOwners.set(abs, entry.role);
    inputDirs.push({ abs, role: entry.role });
    for (const f of entry.files || []) {
      inputOwners.set(path.resolve(f), `${entry.role}（${f}）`);
    }
  }

  const outputOwners = new Map(); // abs -> role
  for (const entry of outputs) {
    if (!entry || !entry.value) continue;
    const abs = path.resolve(entry.value);
    const clashWithOutput = outputOwners.get(abs);
    if (clashWithOutput) {
      throw new Error(
        `出力先が衝突しています: ${clashWithOutput} と ${entry.role} が同一のファイルです (${abs})。` +
          `それぞれの出力先を別々にしてください。`
      );
    }
    const clashWithInput = inputOwners.get(abs);
    if (clashWithInput) {
      throw new Error(
        `出力先 ${entry.role} が入力ファイルと同一のパスです (${abs}, 入力指定: ${clashWithInput})。` +
          `このまま進めると入力を読み終える前に上書きしてしまうため、出力先を別のファイルにしてください。`
      );
    }
    for (const dir of inputDirs) {
      if (abs === dir.abs) {
        throw new Error(
          `出力先 ${entry.role} (${abs}) が入力指定 ${dir.role} と同一のパスです。出力先を別にしてください。`
        );
      }
    }
    outputOwners.set(abs, entry.role);
  }
}

/**
 * 図の出力を「変換してから書き出す」順序で確定させる。
 *
 * 1. `convertPng` / `convertSvg` をメモリ上で先に実行（失敗したら何も書かない）
 * 2. 変換成功後に `.drawio`（XML）と画像を順に書き出す
 *
 * これにより変換失敗時に「新しい XML + 古い PNG」の不整合が残らない。
 *
 * @param {{
 *   xml: string,
 *   outPath: string,
 *   xmlOutPath?: string|null,
 *   convertPng: (xml: string, opts: object) => { png: Buffer, width: number, height: number },
 *   convertSvg: (xml: string, opts: object) => { svg: string, width: number, height: number },
 *   scale?: number,
 *   border?: number,
 *   theme?: string,
 * }} opts
 * @returns {Promise<{ res: object, isSvg: boolean }>}
 */
export async function emitDiagramFiles({
  xml,
  outPath,
  xmlOutPath = null,
  convertPng,
  convertSvg,
  scale = 2,
  border = 16,
  theme = "light",
}) {
  const isSvg = /\.svg$/i.test(outPath);
  const res = isSvg
    ? convertSvg(xml, { scale: 1, border, theme, embedXml: true })
    : convertPng(xml, { scale, border, theme, embedXml: true, dpi: 144 });

  await fsp.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  if (xmlOutPath) {
    await fsp.mkdir(path.dirname(path.resolve(xmlOutPath)), { recursive: true });
    await fsp.writeFile(xmlOutPath, xml, "utf8");
  }
  await fsp.writeFile(outPath, isSvg ? res.svg : res.png);
  return { res, isSvg };
}

/**
 * 「このファイルが直接実行されたのか」を安全に判定する。
 * `node -`（標準入力実行）や実体のない argv[1] では false を返す（ENOENT を投げない）。
 */
export function isDirectRun(importMetaUrl, argv = process.argv) {
  const entry = argv && argv[1];
  if (!entry) return false;
  try {
    return importMetaUrl === pathToFileURL(fsSync.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

/**
 * 生成 XML の健全性チェック（セル ID の一意性・エッジ／parent 参照先・NaN）。
 * 問題があれば人間が読める説明文の配列を返す（空配列 = 問題なし）。
 */
export function inspectXmlCells(xml) {
  const problems = [];
  if (/NaN|Infinity/.test(xml)) problems.push("座標値に NaN / Infinity が入っています");

  const ids = [];
  const edges = [];
  const parents = [];
  const cellRe = /<mxCell\b[^>]*>/g;
  let m;
  while ((m = cellRe.exec(xml)) !== null) {
    const tag = m[0];
    const id = tag.match(/\sid="([^"]*)"/)?.[1];
    if (id == null) {
      problems.push(`id を持たない mxCell: ${tag.slice(0, 80)}`);
      continue;
    }
    ids.push(id);
    if (/\bedge="1"/.test(tag)) {
      edges.push({
        id,
        source: tag.match(/\ssource="([^"]*)"/)?.[1],
        target: tag.match(/\starget="([^"]*)"/)?.[1],
      });
    }
    const parent = tag.match(/\sparent="([^"]*)"/)?.[1];
    if (parent != null) parents.push({ id, parent });
  }
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) problems.push(`mxCell id が重複しています: ${id}`);
    seen.add(id);
  }
  for (const e of edges) {
    for (const [role, ref] of [
      ["source", e.source],
      ["target", e.target],
    ]) {
      if (ref != null && !seen.has(ref)) {
        problems.push(`エッジ ${e.id} の ${role} が存在しないセルを参照しています: ${ref}`);
      }
    }
  }
  for (const p of parents) {
    if (p.parent && !seen.has(p.parent)) {
      problems.push(`セル ${p.id} の parent が存在しません: ${p.parent}`);
    }
  }
  return problems;
}
