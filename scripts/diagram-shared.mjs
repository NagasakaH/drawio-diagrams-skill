/**
 * diagram-shared.mjs
 * 各ビルダー／スキャナで共有する小さなユーティリティ（依存は Node.js 標準モジュールのみ）。
 *
 * - createCellIdMap(): 元 ID → 一意な内部セル ID の対応表
 *   （日本語 ID や記号違いの ID が同じ正規形に潰れて衝突するのを防ぐ）
 * - isDirectRun(): import 時（`node -` / stdin・実体のないエントリ）でも落ちない直接実行判定
 * - inspectXmlCells(): 生成 XML のセル ID 一意性・エッジ／parent 参照先・NaN の検査
 * - expandInputPaths() / assertOutputsDistinctFromInputs() / pathIdentityKeys():
 *   最初の書き込みより前に「出力先が入力ファイルや別の出力先と同一」を検出して止める
 *   （表記だけでなく realpath と (dev, ino) で実体比較。大文字小文字違い・symlink・ハードリンクも掴む。
 *   `link/../target` のように symlink を跨ぐ `..` は path.resolve で折畳まず、必ず OS に解決させる）
 * - resolveWriteTarget() / writeFileAtomic(): OS が解決した実体パスを同じディレクトリの
 *   ランダム名一時ファイル（排他作成）に書き、rename で原子的に置き換える
 */
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
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
 * 複数の出力先どうしが「ファイル」と「その配下の親ディレクトリ」の関係（例: `--json-out result` と
 * `--xml-out result/out.drawio`）になっていないか、書き込み前に検証する。
 * @param {Array<{ role: string, resolved: string }>} resolvedEntries
 */
function foldPathKey(p) {
  let s = String(p);
  if (process.platform === "darwin") s = s.normalize("NFC");
  if (process.platform === "darwin" || process.platform === "win32") {
    s = s.toLowerCase();
  }
  return s;
}

function assertNoOutputAncestorConflict(resolvedEntries) {
  const byNorm = new Map();
  for (const item of resolvedEntries) {
    byNorm.set(foldPathKey(item.resolved), item);
  }
  for (const item of resolvedEntries) {
    let cur = path.dirname(item.resolved);
    for (;;) {
      const parentOwner = byNorm.get(foldPathKey(cur));
      if (parentOwner && parentOwner !== item) {
        throw new Error(
          `出力先が親子パスで衝突しています: ${parentOwner.role} (${parentOwner.resolved}) をファイルとして作成すると、` +
            `${item.role} (${item.resolved}) の親ディレクトリとして使用できません。別の出力先を指定してください。`
        );
      }
      const next = path.dirname(cur);
      if (next === cur) break;
      cur = next;
    }
  }
}

/**
 * 入力・出力パスの重複検査。`--spec` 等の入力・`--xml-out`・`--output` が
 * 実体の同一ファイルや親子パス衝突（`result` と `result/out.png`）になっていたら
 * 人間が読めるエラーを投げる（呼び出し側で exit 1）。
 * @param {Array<{role: string, value?: string|null}>} entries
 */
export function assertDistinctPaths(entries) {
  const seen = new Map(); // 実体キー -> { role, value }
  const resolvedEntries = [];
  for (const { role, value } of entries) {
    if (!value) continue;
    const keys = pathIdentityKeys(value);
    const prev = findOwner(seen, keys);
    if (prev) {
      throw new Error(
        `入出力パスが衝突しています: ${prev.role} と ${role} が同一のファイルです ` +
          `(${prev.value} = ${value})。それぞれの出力先を別々にしてください。`
      );
    }
    for (const k of keys) seen.set(k, { role, value });
    resolvedEntries.push({ role, resolved: resolveLikeKernel(value, { forFile: false }) });
  }
  assertNoOutputAncestorConflict(resolvedEntries);
}

const CLASH_SKIP_DIRS = new Set(["node_modules", ".git", ".terraform", "dist"]);
// 注意: `out` は除かない。スキャナ側（scan-schema など）は `out/` を走査するのに
// 照合だけ除外すると、`--output out/...` が「入力と衝突しない」と誤判定になってしまう。

const PATH_SPLIT_RE = process.platform === "win32" ? /[\\/]+/ : /\/+/;

/**
 * パス表記に `..` 成分が 1 つでもあるか。
 * あれば `path.resolve()` の字句折畳みは OS の実体解決とズレうる
 * （`link/../target` で `link` が別階層への symlink のとき、OS は `link` の先の親へ戻る）。
 */
function hasDotDotSegment(p) {
  return String(p).split(PATH_SPLIT_RE).includes("..");
}

/**
 * そのパスが実在するなら inode / dir キーを keys に足す（symlink エイリアス・
 * ハードリンクを掴むためで、OS の解決（= stat の追従）をそのまま使う）。
 * @returns {boolean} 実在したか
 */
function collectStatKeys(p, keys) {
  let st = null;
  try {
    st = fsSync.statSync(p);
  } catch {
    st = null;
  }
  if (!st) return false;
  // ディレクトリとファイルを同じキー空間で衝突させない
  keys.add(`${st.isDirectory() ? "dir" : "ino"}:${st.dev}:${st.ino}`);
  return true;
}

/** 安全な realpath（失敗時は null）。 */
function realOrNull(p) {
  try {
    return fsSync.realpathSync(p);
  } catch {
    return null;
  }
}

/** 安全な stat（失敗時は null）。symlink は辿って実体の種別を見る。 */
function statOrNull(p) {
  try {
    return fsSync.statSync(p);
  } catch {
    return null;
  }
}

/** 安全な lstat（失敗時は null）。リンク自身（未接続 dangling symlink も含む）を見る。 */
function lstatOrNull(p) {
  try {
    return fsSync.lstatSync(p);
  } catch {
    return null;
  }
}

function hasTrailingSeparator(s) {
  return process.platform === "win32" ? /[\\/]$/.test(s) : s.endsWith("/");
}

function makePathError(code, msg, targetPath) {
  const err = new Error(msg);
  err.code = code;
  if (targetPath !== undefined) err.path = targetPath;
  return err;
}

/**
 * 生パスを「起点ルート」「基準ディレクトリ（相対時）」「残余パス」へ切り分ける。
 * Windows では `C:/work/out.png` のようなスラッシュ混在絶対パスでも `root` を
 * `C:\\` として正しく切り出せるようにし、POSIX では `\` をディレクトリ区切りにしない。
 * @param {string} rawStr
 * @param {string} [platform]
 * @param {string} [cwd]
 */
export function splitPathRoot(rawStr, platform = process.platform, cwd = process.cwd()) {
  const s = String(rawStr ?? "");
  if (platform !== "win32") {
    if (s.startsWith("/")) {
      return { isAbs: true, root: "/", baseDir: cwd, rest: s.replace(/^\/+/, "") };
    }
    return { isAbs: false, root: "/", baseDir: cwd, rest: s };
  }
  const unc = s.match(/^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/);
  if (unc) {
    return {
      isAbs: true,
      root: `\\\\${unc[1]}\\${unc[2]}\\`,
      baseDir: cwd,
      rest: unc[3] ?? "",
    };
  }
  const drvAbs = s.match(/^([A-Za-z]:)[\\/](.*)$/);
  if (drvAbs) {
    return {
      isAbs: true,
      root: `${drvAbs[1].toUpperCase()}\\`,
      baseDir: cwd,
      rest: drvAbs[2],
    };
  }
  const drvRel = s.match(/^([A-Za-z]:)([^\\/].*)?$/);
  if (drvRel) {
    const base = path.win32.resolve(drvRel[1]);
    const baseRoot = path.win32.parse(base).root || `${drvRel[1].toUpperCase()}\\`;
    return {
      isAbs: false,
      root: baseRoot,
      baseDir: base,
      rest: drvRel[2] ?? "",
    };
  }
  const cwdWinRoot = path.win32.parse(path.win32.resolve(cwd)).root || "C:\\";
  if (s.startsWith("/") || s.startsWith("\\")) {
    return {
      isAbs: true,
      root: cwdWinRoot,
      baseDir: cwd,
      rest: s.replace(/^[\\/]+/, ""),
    };
  }
  return { isAbs: false, root: cwdWinRoot, baseDir: cwd, rest: s };
}

/**
 * カーネル（OS）と同じ「成分単位の解決」で絶対パスを確定する。
 *
 * `path.resolve()` は `..` を字句的に潰すだけ、`fs.realpathSync()` も macOS では
 * `link/..` を字句的に潰すためどちらもズレる。1 成分ずつ進めてその都度実在・種別を
 * 確認しながら解決するため、
 *   - `link/../target`（`link` が別階層への symlink）→ 実体の親へ正しく戻る
 *   - `README.md/../NOTICE` / `NOTICE/.` / `NOTICE/` → 通常ファイルをディレクトリ扱い
 *     したためカーネル同様 `ENOTDIR` で拒否する（`NOTICE` の別名上書きを許さない）
 *   - `missing/../NOTICE` → 存在しないディレクトリからの `..` は `ENOENT` で拒否する
 *
 * @param {string} raw 未解決でよい生パス（`..`・symlink を含めてよい）
 * @param {{ forFile?: boolean }} [opts] `forFile: true` なら末尾の `/` や既存ディレクトリも拒否
 */
function resolveLikeKernel(raw, opts = {}) {
  const forFile = opts.forFile === true;
  const rawStr = String(raw ?? "");
  if (!rawStr) {
    if (forFile) throw makePathError("EINVAL", "出力先パスが空です。", rawStr);
    return realOrNull(process.cwd()) || process.cwd();
  }
  const split = splitPathRoot(rawStr);
  let curRoot = split.root;
  const baseAcc = split.isAbs ? split.root : split.baseDir ?? process.cwd();
  let acc = realOrNull(baseAcc) || path.resolve(baseAcc);
  let stAcc = statOrNull(acc);
  let exists = stAcc !== null;

  const ensureTraversableDir = (via) => {
    if (!exists || !stAcc) {
      throw makePathError(
        "ENOENT",
        `途中のディレクトリが存在しないため ${rawStr} (${via}) を解決できません (${acc})。`,
        rawStr
      );
    }
    if (!stAcc.isDirectory()) {
      throw makePathError(
        "ENOTDIR",
        `ディレクトリではないパス (${acc}) を経由するパス (${rawStr}) は使用できません。`,
        rawStr
      );
    }
  };

  let comps = split.rest.split(PATH_SPLIT_RE);
  let idx = 0;
  let symlinkDepth = 0;
  let effectiveTrailingSep = hasTrailingSeparator(rawStr);

  while (idx < comps.length) {
    const comp = comps[idx];
    if (!comp.length) {
      idx += 1;
      continue;
    }
    if (comp === ".") {
      ensureTraversableDir(".");
      idx += 1;
      continue;
    }
    if (comp === "..") {
      ensureTraversableDir("..");
      const parent = path.dirname(acc);
      if (parent !== acc && parent.length >= curRoot.length) {
        acc = parent;
        stAcc = statOrNull(acc);
        exists = stAcc !== null;
      }
      idx += 1;
      continue;
    }
    if (exists) {
      ensureTraversableDir(comp);
    }
    const isEndSep =
      process.platform === "win32"
        ? acc.endsWith("/") || acc.endsWith("\\")
        : acc.endsWith("/");
    const glued = isEndSep ? acc + comp : path.join(acc, comp);
    if (exists) {
      const resolved = realOrNull(glued);
      if (resolved != null) {
        acc = resolved;
        stAcc = statOrNull(acc);
        exists = stAcc !== null;
        idx += 1;
        continue;
      }
      // 未接続（dangling）シンボリックリンクもリンク先へ展開して追跡する（循環は ELOOP）
      const lst = lstatOrNull(glued);
      if (lst && lst.isSymbolicLink()) {
        if (symlinkDepth >= 40) {
          throw makePathError("ELOOP", `シンボリックリンクが循環しています: ${rawStr}`, rawStr);
        }
        const linkTarget = fsSync.readlinkSync(glued);
        const remaining = comps.slice(idx + 1).filter(Boolean);
        const linkSplit = splitPathRoot(linkTarget);
        if (linkSplit.isAbs) {
          curRoot = linkSplit.root;
          acc = realOrNull(linkSplit.root) || path.resolve(linkSplit.root);
        }
        stAcc = statOrNull(acc);
        exists = stAcc !== null;
        if (remaining.length === 0 && hasTrailingSeparator(linkTarget)) {
          effectiveTrailingSep = true;
        }
        comps = [...linkSplit.rest.split(PATH_SPLIT_RE), ...remaining];
        idx = 0;
        symlinkDepth += 1;
        continue;
      }
    }
    acc = glued;
    stAcc = null;
    exists = false;
    idx += 1;
  }

  if (effectiveTrailingSep) {
    if (forFile) {
      if (exists && stAcc?.isDirectory()) {
        throw makePathError("EISDIR", `出力先がディレクトリです: ${rawStr} (${acc})`, rawStr);
      }
      throw makePathError(
        "ENOTDIR",
        `末尾にディレクトリ区切りがあるパスはファイル出力先に指定できません: ${rawStr}`,
        rawStr
      );
    }
    if (exists && stAcc && !stAcc.isDirectory()) {
      throw makePathError(
        "ENOTDIR",
        `ディレクトリではないパスに末尾の区切りがあります: ${rawStr} (${acc})`,
        rawStr
      );
    }
  } else if (forFile && exists && stAcc) {
    if (stAcc.isDirectory()) {
      throw makePathError("EISDIR", `出力先がディレクトリです: ${rawStr} (${acc})`, rawStr);
    }
    if (!stAcc.isFile()) {
      throw makePathError(
        "EINVAL",
        `出力先が通常ファイルではありません（FIFO / デバイス / ソケットは上書きできません）: ${rawStr} (${acc})`,
        rawStr
      );
    }
  }

  return acc;
}

/**
 * パスが指している「実体」を同一視するためのキー列を返す。
 *
 * `path.resolve()` 後の文字列一致だけでは、次の実体衝突を取りこぼす。
 *   - macOS / Windows の大文字小文字を区別しないファイルシステム
 *     （`ecommerce.sql` と `ECOMMERCE.SQL` は同一ファイル）
 *   - symlink エイリアス（`latest.tf -> main.tf`、`/tmp` → `/private/tmp`）
 *   - ハードリンク（別名だが実体は同じ inode）
 *   - symlink を跨ぐ `..`（`link/../target` は `link` の先の親の `target` であり、
 *     `path.resolve` が作る `dir/target` とは別物）
 * そこでキーは「OS に聞いた実体」から作る。
 *   1. resolveLikeKernel() — カーネルと同じ成分単位解決の絶対パス（未作成でも作れる）
 *   2. 生表記への statSync — 実在するなら (dev, ino)
 *   3. `..` を含まない表記に限って `path.resolve()` 後の表記キー
 *      （`..` を含む表記の折畳み結果は OS の解決とズレうるので、誤検出を防ぐため作らない）
 *
 * @param {string} raw 未解決でよい（`..` や symlink を含む表記のまま渡す）
 * @returns {Set<string>} 実体キーの集合（キーが 1 つでも共通なら同一実体）
 */
export function pathIdentityKeys(raw) {
  const rawStr = String(raw ?? "");
  const caseInsensitive = process.platform === "darwin" || process.platform === "win32";
  const abs = path.resolve(rawStr);
  const pathKey = process.platform === "darwin" ? foldPathKey(abs) : abs;
  const keys = new Set();

  if (!hasDotDotSegment(rawStr)) {
    keys.add(`path:${pathKey}`);
    if (caseInsensitive) keys.add(`real:${foldPathKey(abs)}`);
  }
  keys.add(`real:${foldPathKey(resolveLikeKernel(rawStr, { forFile: false }))}`);
  collectStatKeys(rawStr.length ? rawStr : abs, keys);
  return keys;
}

/**
 * 書き込み先として OS が実際に解決するファイル用の絶対パスを返す。
 * `path.resolve()` と違い symlink を辿った実体を返すほか、`NOTICE/` や
 * `README.md/../NOTICE` のように非ディレクトリをディレクトリ扱いした指定を拒否する。
 * @param {string} target
 */
export function resolveWriteTarget(target) {
  return resolveLikeKernel(target, { forFile: true });
}

/** キー集合のどれかを所有している持ち主を返す（無ければ null）。 */
function findOwner(ownerMap, keys) {
  for (const k of keys) {
    const owner = ownerMap.get(k);
    if (owner) return owner;
  }
  return null;
}

/** 2 つのキー集合が 1 つ以上共通するか。 */
function keysIntersect(a, b) {
  for (const k of a) if (b.has(k)) return true;
  return false;
}

/**
 * 書き込みを行う前の「上書き防止」検査。
 *
 * 出力パス（`--json-out` / `--xml-out` / `--output`）が
 *   1. 別の出力パスと同一の実体、または
 *   2. 入力ファイル（スキャナが読み取るファイル）と同一の実体、または
 *   3. 入力として指定されたパスそのものと同一の実体
 * のいずれかなら、1 バイトも書き込む前に人間が読めるエラーを投げる（呼び出し側で exit 1）。
 * 「同一の実体」の判定は pathIdentityKeys() — 表記だけでなく realpath と (dev, ino) も見る。
 *
 * @param {{
 *   inputs: Array<{role: string, value?: string, files?: string[]}>,
 *   outputs: Array<{role: string, value?: string|null}>,
 * }} opts
 */
export function assertOutputsDistinctFromInputs({ inputs = [], outputs = [] }) {
  const inputOwners = new Map(); // 実体キー -> 説明
  const inputDirs = []; // { keys, role, abs }

  for (const entry of inputs) {
    if (!entry) continue;
    if (entry.value) {
      const abs = path.resolve(entry.value);
      // 表記（`..` を含む生の指定）を崩さず渡す。折畳んでから OS に聞くと別物と誤認する
      const dirKeys = pathIdentityKeys(entry.value);
      inputDirs.push({ keys: dirKeys, role: entry.role, abs });
      for (const k of dirKeys) {
        if (!inputOwners.has(k)) inputOwners.set(k, `${entry.role} (${abs})`);
      }
    }
    // `files` はスキャナが実際に走査した一覧。value 無しでも照合対象にする。
    for (const f of entry.files || []) {
      for (const k of pathIdentityKeys(f)) {
        if (!inputOwners.has(k)) inputOwners.set(k, `${entry.role}（${path.resolve(f)}）`);
      }
    }
  }

  const outputOwners = new Map(); // 実体キー -> role
  const resolvedOutputs = [];
  for (const entry of outputs) {
    if (!entry || !entry.value) continue;
    const abs = path.resolve(entry.value);
    const keys = pathIdentityKeys(entry.value);

    for (const dir of inputDirs) {
      if (keysIntersect(dir.keys, keys)) {
        throw new Error(
          `出力先 ${entry.role} (${abs}) が入力指定 ${dir.role} と同一のパスです。出力先を別にしてください。`
        );
      }
    }
    const clashWithOutput = findOwner(outputOwners, keys);
    if (clashWithOutput) {
      throw new Error(
        `出力先が衝突しています: ${clashWithOutput} と ${entry.role} が同一のファイルです (${abs})。` +
          `それぞれの出力先を別々にしてください。`
      );
    }
    const clashWithInput = findOwner(inputOwners, keys);
    if (clashWithInput) {
      throw new Error(
        `出力先 ${entry.role} が入力ファイルと同一のファイルです (${abs}, 入力指定: ${clashWithInput})。` +
          `このまま進めると入力を読み終える前に上書きしてしまうため、出力先を別のファイルにしてください。`
      );
    }
    // 出力先自体がディレクトリ・FIFO 等・または `NOTICE/`・`README.md/../NOTICE` 等の
    // 不正なファイルパスでないことも、先立つ別の出力を書き始める前にここで確定させる。
    const resolved = resolveWriteTarget(entry.value);
    resolvedOutputs.push({ role: entry.role, resolved });
    for (const k of keys) outputOwners.set(k, entry.role);
  }
  assertNoOutputAncestorConflict(resolvedOutputs);
}

/**
 * 入力として指定されたパス（ファイルまたはディレクトリ）を、
 * 「スキャナが読み取り得るファイル一覧」へ展開する（照合専用の緩い走査）。
 *
 * - ディレクトリは再帰的に走査し、`extensionRe` に一致するファイルを列挙する
 * - 存在しないパス・読み取れないディレクトリは落とさず、指定された絶対パスそのまま残す
 *   （照合だけで使いたいので、走査失敗をエラーにしない）
 * - 各スキャナ固有の走査（scan-schema / scan-terraform / scan-classes）とは
 *   スキップ規則が異なるため、これは事前チェック用。書き込み直前の再チェックには
 *   必ずスキャナが実際に走査した一覧（collect*Files / scannedInputFiles）を渡すこと。
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

const TARGET_LOCKS = new Map();
const LOCK_MAGIC = "drawio-diagrams-lock-v1";
const RECLAIM_MAGIC = "drawio-diagrams-reclaim-v1";

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

function defaultLockBaseDir() {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp") : os.tmpdir();
  }
  return "/tmp";
}

export async function ensureLockDir(baseDir = null) {
  const rawBase = baseDir || defaultLockBaseDir();
  const baseRoot = realOrNull(rawBase) || path.resolve(rawBase);
  const uidPart = typeof process.getuid === "function" ? `u${process.getuid()}` : "default";
  const lockDir = path.join(baseRoot, `drawio-diagrams-locks-${uidPart}`);

  let preExisting = lstatOrNull(lockDir);
  if (!preExisting) {
    try {
      await fsp.mkdir(lockDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      // POSIX で /tmp 配下に作成できない場合も TMPDIR 等へはフォールバックせずフェイルクローズする
      preExisting = lstatOrNull(lockDir);
      if (!preExisting) throw err;
    }
  }

  const dirLst = await fsp.lstat(lockDir);
  if (!dirLst.isDirectory() || dirLst.isSymbolicLink()) {
    throw makePathError(
      "EINVAL",
      `ロック用ディレクトリが通常のディレクトリではありません: ${lockDir}`,
      lockDir
    );
  }
  if (typeof process.getuid === "function") {
    if (dirLst.uid !== process.getuid()) {
      throw makePathError(
        "EACCES",
        `ロック用ディレクトリの所有者が一致しません: ${lockDir}`,
        lockDir
      );
    }
    if ((dirLst.mode & 0o077) !== 0 || (dirLst.mode & 0o700) !== 0o700) {
      throw makePathError(
        "EACCES",
        `ロック用ディレクトリの権限は 0700 である必要があります (現在 ${(dirLst.mode & 0o777).toString(8).padStart(4, "0")}): ${lockDir}`,
        lockDir
      );
    }
  }
  return lockDir;
}

export async function getTargetLockPaths(targetPath, baseDir = null) {
  const lockDir = await ensureLockDir(baseDir);
  const canonical = resolveWriteTarget(targetPath);
  const key = foldPathKey(canonical);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return {
    canonical,
    key,
    hash,
    lockDir,
    lockPath: path.join(lockDir, `${hash}.lock`),
  };
}

async function readRegularLockRecord(p) {
  const lst = await fsp.lstat(p);
  if (!lst.isFile() || lst.isSymbolicLink()) {
    throw makePathError("EINVAL", `ロックパスが通常ファイルではありません: ${p}`, p);
  }
  const raw = await fsp.readFile(p, "utf8");
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  return { lst, raw, data };
}

async function writePrivateLockFile(p, payload) {
  const fh = await fsp.open(p, "wx", 0o600);
  let ok = false;
  try {
    await fh.writeFile(payload, "utf8");
    const st = await fh.stat();
    ok = true;
    return st;
  } finally {
    await fh.close().catch(() => {});
    if (!ok) await fsp.rm(p, { force: true }).catch(() => {});
  }
}

async function createExclusiveLockFile(p, payload) {
  // 先にプライベート一時ファイルへ完全な JSON を書き終えてから fsp.link で原子的に公開する
  // （0 バイトの空ロック状態が存在しないため、停止中プロセスの生存ロック誤回収が起きない）
  const dir = path.dirname(p);
  const tmp = path.join(dir, `.stage-${process.pid}-${randomBytes(8).toString("hex")}`);
  const ourStat = await writePrivateLockFile(tmp, payload);
  try {
    await fsp.link(tmp, p);
    return ourStat;
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

async function releaseOwnedLock(p, ourStat, ourNonce) {
  const cur = lstatOrNull(p);
  if (!cur || !cur.isFile() || cur.isSymbolicLink()) return;
  if (process.platform !== "win32") {
    if (!ourStat || cur.dev !== ourStat.dev || cur.ino !== ourStat.ino) return;
  } else {
    const raw = await fsp.readFile(p, "utf8").catch(() => null);
    if (!raw) return;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.nonce !== ourNonce) return;
  }
  await fsp.rm(p, { force: true }).catch(() => {});
}

function isLockRecordReclaimable(lst, raw, data, lockPath) {
  if (data && data.magic === LOCK_MAGIC && Number.isInteger(data.pid)) {
    return !isProcessAlive(data.pid);
  }
  throw makePathError("EEXIST", `想定外のロックファイルが存在します: ${lockPath}`, lockPath);
}

function makeDeadLockTag(lst, data) {
  const rawNonce = typeof data?.nonce === "string" && data.nonce ? data.nonce : "empty";
  const safeNonce = rawNonce.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "empty";
  return `${lst.dev}_${lst.ino}_${safeNonce}`;
}

/**
 * 出力ファイル単位のプロセス間排他ロックを取得し、解放関数を返す。
 * ロックは UID 専有の `0700` ディレクトリ（POSIX は `/tmp` 固定）配下に正規化パスの SHA-256 キーで置き、
 * 一時ファイル書き込み完了後に `link` で公開するため空ロック状態を作らない。
 * 生存プロセスのロックは経過時間で奪取せず、死亡 PID の回収は上限なしの `deadTag + k` スロットラダー＋
 * 原子的 `rename` で（他者スロットを削除せずに ABA 競合なしで）行う。
 */
async function acquireFileLock(canonicalKey, timeoutMs = 15000) {
  const lockDir = await ensureLockDir();
  const hash = createHash("sha256").update(canonicalKey).digest("hex").slice(0, 32);
  const lockPath = path.join(lockDir, `${hash}.lock`);
  const myNonce = randomBytes(8).toString("hex");
  const payload = JSON.stringify({
    magic: LOCK_MAGIC,
    pid: process.pid,
    nonce: myNonce,
    createdAt: Date.now(),
  });
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const ourStat = await createExclusiveLockFile(lockPath, payload);
      return () => releaseOwnedLock(lockPath, ourStat, myNonce);
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;

      let rec;
      try {
        rec = await readRegularLockRecord(lockPath);
      } catch (readErr) {
        if (readErr && readErr.code === "ENOENT") continue;
        throw readErr;
      }

      if (isLockRecordReclaimable(rec.lst, rec.raw, rec.data, lockPath)) {
        const deadTag = makeDeadLockTag(rec.lst, rec.data);
        let claimedSlot = null;

        for (let k = 0; ; k += 1) {
          if (Date.now() >= deadline) {
            throw new Error(`出力先の排他ロック取得がタイムアウトしました: ${canonicalKey}`);
          }
          const slotPath = path.join(lockDir, `${hash}.reclaim-${deadTag}-${k}`);
          const rPayload = JSON.stringify({
            magic: RECLAIM_MAGIC,
            pid: process.pid,
            nonce: myNonce,
            deadTag,
            slot: k,
            createdAt: Date.now(),
          });
          try {
            const rStat = await createExclusiveLockFile(slotPath, rPayload);
            claimedSlot = { path: slotPath, stat: rStat, k };
            break;
          } catch (recErr) {
            if (!recErr || recErr.code !== "EEXIST") throw recErr;
            let slotRec;
            try {
              slotRec = await readRegularLockRecord(slotPath);
            } catch (rStatErr) {
              if (rStatErr && rStatErr.code === "ENOENT") {
                break;
              }
              throw rStatErr;
            }

            const { data: rData } = slotRec;
            if (rData && rData.magic === RECLAIM_MAGIC && Number.isInteger(rData.pid)) {
              if (isProcessAlive(rData.pid)) {
                break;
              }
              // スロット保持者が死亡している場合は削除せず（ABA 回避）、次のスロット k+1 へ進む
              continue;
            }
            throw makePathError(
              "EEXIST",
              `想定外の回収スロットファイルが存在します: ${slotPath}`,
              slotPath
            );
          }
        }

        if (claimedSlot) {
          try {
            let lockVanished = false;
            let stillSameDead = false;
            try {
              const cur = await readRegularLockRecord(lockPath);
              if (
                makeDeadLockTag(cur.lst, cur.data) === deadTag &&
                isLockRecordReclaimable(cur.lst, cur.raw, cur.data, lockPath)
              ) {
                stillSameDead = true;
              }
            } catch (curErr) {
              if (curErr && curErr.code === "ENOENT") {
                lockVanished = true;
              } else {
                throw curErr;
              }
            }

            if (lockVanished) {
              try {
                const ourStat = await createExclusiveLockFile(lockPath, payload);
                return () => releaseOwnedLock(lockPath, ourStat, myNonce);
              } catch (e2) {
                if (!e2 || e2.code !== "EEXIST") throw e2;
              }
            } else if (stillSameDead) {
              const tmpTakeover = path.join(
                lockDir,
                `${hash}.takeover-${process.pid}-${randomBytes(6).toString("hex")}`
              );
              const ourStat = await writePrivateLockFile(tmpTakeover, payload);
              try {
                const latest = await readRegularLockRecord(lockPath);
                if (
                  makeDeadLockTag(latest.lst, latest.data) === deadTag &&
                  isLockRecordReclaimable(latest.lst, latest.raw, latest.data, lockPath)
                ) {
                  await fsp.rename(tmpTakeover, lockPath);
                  for (let prevK = 0; prevK < claimedSlot.k; prevK += 1) {
                    const prevPath = path.join(lockDir, `${hash}.reclaim-${deadTag}-${prevK}`);
                    const pLst = lstatOrNull(prevPath);
                    if (pLst && pLst.isFile() && !pLst.isSymbolicLink()) {
                      await fsp.rm(prevPath, { force: true }).catch(() => {});
                    }
                  }
                  return () => releaseOwnedLock(lockPath, ourStat, myNonce);
                }
                await fsp.rm(tmpTakeover, { force: true }).catch(() => {});
              } catch (renErr) {
                await fsp.rm(tmpTakeover, { force: true }).catch(() => {});
                if (!renErr || renErr.code !== "ENOENT") throw renErr;
              }
            }
          } finally {
            await releaseOwnedLock(claimedSlot.path, claimedSlot.stat, myNonce);
          }
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(`出力先の排他ロック取得がタイムアウトしました: ${canonicalKey}`);
      }
      await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 20)));
    }
  }
}

/**
 * 同一プロセス内＋プロセス間で同じ出力ファイルを更新する並行実行を直列化する。
 * `emitDiagramFiles` が複数同時に呼ばれて XML と画像の `rename` が交差し、
 * 「XML は実行 B、画像は実行 A」という世代不整合が残るのを防ぐ。
 * デッドロックを避けるため、対象パスをソートした順でロックを積み上げる。
 */
async function withTargetLocks(targetPaths, fn) {
  const sortedKeys = [
    ...new Set((targetPaths || []).filter(Boolean).map((p) => foldPathKey(p))),
  ].sort();

  const memReleases = [];
  const fileReleases = [];
  try {
    for (const key of sortedKeys) {
      const prev = TARGET_LOCKS.get(key) || Promise.resolve();
      let release;
      const next = new Promise((resolve) => {
        release = resolve;
      });
      const tail = prev.catch(() => {}).then(() => next);
      TARGET_LOCKS.set(key, tail);
      await prev.catch(() => {});
      memReleases.push(() => {
        release();
        if (TARGET_LOCKS.get(key) === tail) {
          TARGET_LOCKS.delete(key);
        }
      });
    }
    for (const key of sortedKeys) {
      fileReleases.push(await acquireFileLock(key));
    }
    return await fn();
  } finally {
    for (let i = fileReleases.length - 1; i >= 0; i -= 1) {
      await fileReleases[i]();
    }
    for (let i = memReleases.length - 1; i >= 0; i -= 1) {
      memReleases[i]();
    }
  }
}

/**
 * 同ディレクトリ内に排他作成した一時ファイルへ `data` を書き出し、一時ファイルパスを返す。
 * 予測できる一時ファイル名（`.tmp-<pid>`）は使わず、ランダム 16 進接尾語 + `wx` で衝突を避ける。
 * POSIX で既存ファイルが `0600` 等の制限権限を持つ場合、新規開時から `0600` かつ `rename` 前に
 * 元の権限を忠実に復元して umask `022` で `0644` へ広がらないようにする。
 */
async function stageTempFile(absTarget, data) {
  const dir = path.dirname(absTarget);
  const existingStat = process.platform !== "win32" ? statOrNull(absTarget) : null;
  const preserveMode =
    existingStat && existingStat.isFile() ? existingStat.mode & 0o777 : null;
  const openMode = preserveMode !== null ? 0o600 : 0o666;
  let tmp = null;
  let createdTmp = false;
  try {
    for (let attempt = 0; ; attempt += 1) {
      const rand = randomBytes(8).toString("hex");
      const candidate = path.join(dir, `.drawio.tmp-${process.pid}-${rand}`);
      try {
        const fh = await fsp.open(candidate, "wx", openMode);
        tmp = candidate;
        createdTmp = true;
        try {
          await fh.writeFile(data);
          if (preserveMode !== null) {
            await fh.chmod(preserveMode);
          }
        } finally {
          await fh.close();
        }
        return tmp;
      } catch (err) {
        if (createdTmp) {
          throw err;
        }
        if (err && err.code === "EEXIST" && attempt < 8) continue;
        throw err;
      }
    }
  } catch (err) {
    if (createdTmp && tmp) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
    throw err;
  }
}

/**
 * ファイルを「同じディレクトリの一時ファイル → rename」で原子的に書き出す。
 *
 * - 書き先は resolveWriteTarget() で OS の実体解決をしてから決める
 *   （`link/../out.png` や `NOTICE/`・FIFO のような不正指定で別ファイル／特殊ファイルを壊さないため）
 * - 既存ファイルの POSIX パーミッション（`0600` 等）を維持する
 * - 途中で失敗しても元のファイルは残り、一時ファイルを置き去りにしない
 */
export async function writeFileAtomic(target, data) {
  const abs = resolveWriteTarget(target);
  const tmp = await stageTempFile(abs, data);
  try {
    await fsp.rename(tmp, abs);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * 図の出力を「変換 → プロセス内外の対象ロック下で両一時ファイル確定 → rename（失敗時はロールバック）」で揃える。
 *
 * 1. `--xml-out` / `--output` の同一性・親子パス衝突・有効な通常ファイルパス性を確定する
 * 2. `convertPng` / `convertSvg` をメモリ上で先に実行（失敗したら何も書かない）
 * 3. `withTargetLocks`（プロセス内直列化＋プロセス間 `.drawio-lock` 排他ロック）で
 *    同一出力先への並行実行を直列化し、XML と画像の世代混在を防ぐ
 * 4. XML と画像の両方を一時ファイルへ `stageTempFile()`（権限維持付き）で書き出してから確定する
 * 5. XML 置換後に画像側 `rename` が失敗した場合は、既存 XML の元の内容（新規作成時は
 *    削除）へベストエフォートのロールバックを行い、一時ファイルも残さない
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
  // 書き込み直前にもう一度。「.drawio（xml-out）」と「画像（output）」が symlink や
  // `link/../name` の別表記で同一実体・親子パス衝突になっていたら 1 バイトも書かずに止まる
  assertDistinctPaths([
    { role: "--xml-out", value: xmlOutPath },
    { role: "--output", value: outPath },
  ]);

  const absOut = resolveWriteTarget(outPath);
  const absXml = xmlOutPath ? resolveWriteTarget(xmlOutPath) : null;

  const res = isSvg
    ? convertSvg(xml, { scale: 1, border, theme, embedXml: true })
    : convertPng(xml, { scale, border, theme, embedXml: true, dpi: 144 });

  return withTargetLocks([absOut, absXml], async () => {
    await fsp.mkdir(path.dirname(absOut), { recursive: true });
    if (absXml) {
      await fsp.mkdir(path.dirname(absXml), { recursive: true });
    }

    let outTmp = null;
    let xmlTmp = null;
    let prevXml = null;
    let xmlCommitted = false;
    try {
      outTmp = await stageTempFile(absOut, isSvg ? res.svg : res.png);
      if (absXml) {
        const xmlSt = statOrNull(absXml);
        if (xmlSt && !xmlSt.isFile()) {
          throw makePathError(
            "EINVAL",
            `出力先が通常ファイルではないため上書きできません: ${absXml}`,
            absXml
          );
        }
        xmlTmp = await stageTempFile(absXml, xml);
        prevXml = xmlSt
          ? await fsp.readFile(absXml).catch((err) => {
              if (err && err.code === "ENOENT") return null;
              throw err;
            })
          : null;
        await fsp.rename(xmlTmp, absXml);
        xmlTmp = null;
        xmlCommitted = true;
      }
      await fsp.rename(outTmp, absOut);
      outTmp = null;
    } catch (err) {
      if (outTmp) await fsp.rm(outTmp, { force: true }).catch(() => {});
      if (xmlTmp) await fsp.rm(xmlTmp, { force: true }).catch(() => {});
      if (xmlCommitted && absXml) {
        if (prevXml === null) {
          await fsp.rm(absXml, { force: true }).catch(() => {});
        } else {
          const rTmp = await stageTempFile(absXml, prevXml).catch(() => null);
          if (rTmp) {
            await fsp.rename(rTmp, absXml).catch(async () => {
              await fsp.rm(rTmp, { force: true }).catch(() => {});
            });
          }
        }
      }
      throw err;
    }
    return { res, isSvg };
  });
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
