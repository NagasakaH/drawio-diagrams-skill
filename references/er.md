> 統合スキル `drawio-diagrams-skill` のうち **Crow's Foot ER 図** を担当するリファレンス。
> 実行はすべて `node scripts/drawio-cli.mjs er ...` / `node scripts/scan-schema.mjs ...` 経由。

# SQL / Prisma → Crow's Foot ER 図生成スキル (`drawio-er`)

SQL DDL（PostgreSQL / MySQL / SQLite 系の `CREATE TABLE` / `ALTER TABLE`）と Prisma スキーマを
Pure Node.js スキャナで静的解析し、テーブル・外部キー・ユニーク制約を抽出して、
**Crow's Foot 記法の ER 図**を `.drawio` XML および `.drawio.png`（元XML埋め込み済み・draw.io再編集可能）として生成する。

- **ゼロ依存**: `npm install` 不要。Node.js 標準ライブラリと同梱の `scripts/drawio2png.mjs`（ブラウザ不要コンバーター）のみ使用。
- **再編集可能**: 出力PNGには元XMLが埋め込まれており、draw.io アプリで開くとカード・関係線ともに編集できる。
- **2段階ワークフロー**: `--schema`（自動スキャン）→ JSON スペック保存 → 仕上げて `--spec` で再描画、が可能。

---

## 使い方

```bash
# SQL DDL（または Prisma / ディレクトリ）から直接生成（JSON スペックも同時保存）
node scripts/drawio-cli.mjs er \
  --schema examples/er/sample-schema/ecommerce.sql \
  --output examples/output/ecommerce-er.drawio.png \
  --json-out examples/output/ecommerce-er.json

# 2段階目: JSON スペックを編集してから再描画
node scripts/drawio-cli.mjs er \
  --spec examples/output/ecommerce-er.json \
  --output examples/output/ecommerce-er.drawio.png

# スキャンだけ実施して JSON を得る（描画しない）
node scripts/scan-schema.mjs src/db/ -o er-spec.json
```

`npm run demo` でサンプル（EC サイト 7 テーブル）の一括生成が確認できる。

### build-er.mjs の主なオプション

| オプション | 説明 |
|---|---|
| `--schema <path>` | `.sql` / `.prisma` ファイルまたはディレクトリ（複数指定可） |
| `-i, --spec <path>` | JSON スペックを直接指定（`--schema` と排他） |
| `-o, --output <path>` | 出力 PNG（`.svg` 拡張なら SVG 出力）。既定 `er.drawio.png` |
| `--xml-out <path>` | `.drawio` XML の出力先（既定: 出力PNGと同じ場所） |
| `--json-out <path>` | `--schema` 時に抽出した JSON スペックを保存 |
| `--follow-symlinks` | ディレクトリスキャンで symlink を辿る（既定は辿らない） |
| `--title / --subtitle` | 図タイトル・サブタイトルの上書き |
| `-s, --scale` / `-b, --border` / `--theme` | PNG 倍率（既定2）・余白（既定16）・light/dark |

---

## SQL DDL / Prisma のスキャン手順

`scripts/scan-schema.mjs` が行う解析内容:

1. **SQL DDL** (`CREATE TABLE` / `ALTER TABLE`):
   - `CREATE TABLE` のカラム定義（型、`PRIMARY KEY`、`NOT NULL`、`UNIQUE`、`DEFAULT`）
   - 複合主キー `PRIMARY KEY (a, b)`、テーブル制約 `CONSTRAINT ... FOREIGN KEY ... REFERENCES ...`、
     `UNIQUE (...)`（複合ユニークは列に `compositeUnique` として記録）
   - カラムインラインの `REFERENCES other(id)`（名前付き制約でなくても外部キーとして認識）
   - `ALTER TABLE x ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES y (...)`
   - PostgreSQL の `COMMENT ON TABLE / COLUMN` → `displayName` / `comment`
2. **Prisma** (`model` / `type` ブロック):
   - `@id` / `@unique` / `@@id([...])` / `@@unique([...])`、`?` による NULL 許容、`Role[]` 等の配列型
   - `@relation(fields: [...], references: [...])` を外部キー関係として抽出（enum 型は関係にしない）
   - `///` ドキュメントコメント → `comment`
3. **Cardinality 推定**（`<親側>:<子側>` の 2 成分を別々に求める）:
   - **親側**（子から見た親の存在性）: FK 列がすべて `NOT NULL` → `1`（必ず1）。
     いずれかが NULL 許容（例: `categories.parent_id`）→ `0..1`（0または1）
   - **子側**（親から見た子の個数）: 通常の FK だけでは下限は常に `0`（住所 0 件のユーザーも合法）。
     FK 列集合**全体**が主キーまたは UNIQUE 制約と一致するときだけ上限 `1` → `0..1`、
     それ以外 → `0..N`
   - 複合 PK / 複合 UNIQUE の**一部列**を単独ユニークとは判定しない（列集合の完全一致で判定）
4. 存在しないテーブル参照の除外、関係の重複排除、`id` の採番。

スキャン結果は必ず `--json-out` か `-o` で保存し、誤検知（enum と同名モデル、複合 FK など）が
あれば JSON を修正してから描画する。

ディレクトリを渡したときの走査は次のとおり。

- `.` で始まるディレクトリ、`node_modules`、`migrations` は読まない（マイグレーション履歴は
  過去の DDL であり現在のスキーマと混ざるため）。
- **symlink は既定で辿らない**。指定ディレクトリ（走査 root）の外へ抜けるリンクや、
  循環リンク・切断リンクによる無限走査を防ぐため。辿りたいときは `--follow-symlinks` を付ける
  （その場合も実ディレクトリの重複訪問は防ぐ）。
- 読めないエントリは警告を出してスキップし、走査そのものは続行する。

---

## JSON スペックを直接編集する手順

スペックの全フィールドは 本ドキュメント末尾のスペック仕様 を参照。よくある編集:

- **表示名**: `tables[].displayName` に日本語名（例 `"ユーザー"`）を入れるとヘッダー右に表示。
- **ドメイン色**: `tables[].domain`（例 `"決済"`）を 1 つでも設定すると、ドメインごとにヘッダー色が分かれる。
  何も設定しない場合は役割ベース（親=ティール / 中間=インディゴ / 末端=ブルー / 孤立=スレート）。
- **配置の固定**: `tables[].row` / `tables[].col`（0 から）を指定すると自動レイアウトではなく指定位置に配置。
  未指定のテーブルは関係の深度から自動で列を割り当てる（親が左・子が右）。
- **Cardinality の上書き**: `relations[].cardinality` を `"1:N"` / `"1:0..N"` / `"1:1"` / `"1:0..1"` /
  `"0..1:N"` / `"0..1:0..1"` / `"0..1:0..N"` の 7 値のいずれかに直接変更。`label` は関係線の中点に白背景で表示される。
- **列の並び替え・間引き**: `columns` の配列順が行順。図示不要な列は削除してよい。
- カラムの `pk` / `fk` / `unique` / `notNull` / `compositeUnique` / `comment` を直接修正できる。

## 描画ルール（レイアウト engine の決めること）

- 白背景、左上にティール (`#0D9488`) のアクセントバー＋18px 太字タイトル＋11px サブタイトル、
  その下に細い `#E2E8F0` の区切り線、右上にコンパクトな凡例ボックス（PK / FK / UK と `1 : N` / `1 : 0..N` / `0..1 : 0..N` の見本）。
- テーブルカード: 列名は自動幅（最長の列名＋型に合わせて計算）、PK 行の後に区切り線、行は白 / `#F8FAFC` の
  市松模様。PK=アンバー・FK=ブルー・UK=パープルのバッジ、型はグレーの等幅フォント、NOT NULL は `NN`。
- 関係線: `from` が親（`startArrow` 側＝`‖`）、`to` が子（`endArrow` 側＝カラスの足）。
  隣接列間は左右サイドポートへ直行、列を 2 つ以上跨ぐ線は区切り線直下の専用レーン経由で、
  テーブルカードや他の線を_crossしないようポートを分散する。
  自己参照（`parent_id` など）はカード左側のループで描く。

---

# ER スペック JSON スキーマ (`drawio-er`)

`scripts/scan-schema.mjs` の出力形式であり、`build-er.mjs --spec` が入力とする形式。
人手で編集する場合はこのファイルを正規の図面定義として扱ってよい。

```jsonc
{
  "title": "データベース ER 図（エンティティ関係図）", // 省略可（既定値あり）
  "subtitle": "Crow's Foot 記法 · ecommerce.sql",       // 省略可
  "sources": ["ecommerce.sql"],                          // 出典ファイル名（フッターに表示）
  "tables": [ /* 下記参照 */ ],
  "relations": [ /* 下記参照 */ ]
}
```

---

## `tables[]` — テーブル（エンティティ）

| フィールド | 型 | 説明 |
|---|---|---|
| `name` | string | テーブル名。ヘッダー左に白抜き太字で表示。`relations` の `from` / `to` はこの名前で紐づく |
| `displayName` | string? | 日本語名などの別名。ヘッダー右に薄白 (`#E2E8F0`) で表示 |
| `source` | string? | 定義元ファイル名（スキャナが自動記入） |
| `domain` | string? | ドメイン名。1 つ以上のテーブルが設定すると、ヘッダー色がドメインごとに変わる |
| `color` | string? | ヘッダー色の手動指定（`"#RRGGBB"`）。`domain` より優先 |
| `row` / `col` | int? | 配置の手動固定（0 始まり）。片方だけでも指定可。未指定のテーブルは関係深度から自動配置 |
| `columns` | Column[] | カラム定義。配列順そのままに行として上から描かれる |

### `columns[]`

| フィールド | 型 | 説明 |
|---|---|---|
| `name` | string | 列名（等幅フォント表示。PK は太字） |
| `type` | string | データ型表示文字列（`varchar(255)`、`bigint`、`Post[]` など自由記述） |
| `pk` | bool | 主キー。PK バッジ（アンバー）＋太字。PK 行の後に細い区切り線が入る |
| `fk` | bool | 外部キー。FK バッジ（ブルー） |
| `unique` | bool | ユニーク制約（PK 以外）。UK バッジ（パープル） |
| `compositeUnique` | bool | 複合ユニークの一部。バッジは出さず、1:1 判定の手がかりになる |
| `notNull` | bool | NOT NULL。PK 以外で true なら行末に `NN` |
| `comment` | string? | 列コメント（現状は描画に使わないが保持してよい） |

---

## `relations[]` — 外部キー関係（Crow's Foot 線）

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string | 一意 ID（省略時は自動採番） |
| `from` | string | **親**テーブル名（`1` 側・`startArrow` 側・`‖` マーカー） |
| `to` | string | **子**テーブル名（`N` 側・`endArrow` 側・カラスの足） |
| `fromColumns` | string[] | 親側の参照列（`references` 側） |
| `toColumns` | string[] | 子側の外部キー列。線のラベル省略時の候補にもなる |
| `label` | string? | 線の中点に白背景で表示するラベル（通常は FK 列名や制約名） |
| `cardinality` | string | 下記 7 値のいずれか（下表） |
| `startArrow` / `endArrow` | string? | マーカーの手動上書き（`ERmandOne` / `ERzeroToOne` / `ERoneToMany` / `ERzeroToMany`） |

### `cardinality` と描画マーカー

| cardinality | 親側 (`startArrow`) | 子側 (`endArrow`) | 意味 |
|---|---|---|---|
| `1:N` | `ERmandOne` | `ERoneToMany` | 親は必ず 1 件、子は 1 件以上ありうる |
| `1:0..N` | `ERmandOne` | `ERzeroToMany` | 親は必ず 1 件、子は 0 件以上（NOT NULL FK の多数側） |
| `1:1` | `ERmandOne` | `ERmandOne` | 両側とも必ず 1 件 |
| `1:0..1` | `ERmandOne` | `ERzeroToOne` | 親は必ず 1 件、子は高々 1 件（UNIQUE な NOT NULL FK） |
| `0..1:N` | `ERzeroToOne` | `ERoneToMany` | 親側も任意（NULL 許容 FK＋子必須） |
| `0..1:0..1` | `ERzeroToOne` | `ERzeroToOne` | 親も子も任意（NULL 許容の UNIQUE FK） |
| `0..1:0..N` | `ERzeroToOne` | `ERzeroToMany` | 親も子も任意（NULL 許容 FK の多数側） |

### スキャナの cardinality 推定規則

Cardinality は「親側 : 子側」の 2 要素で決まる。

- **親側**（子が親を参照する側）: FK 列がすべて `NOT NULL` → `1`、いずれかが NULL 許容 → `0..1`
  （例: `addresses.user_id` は NOT NULL → `1`、`categories.parent_id` は NULL 許容 → `0..1`）
- **子側**: 下限は常に `0`（親が子を持たないことは普通にある）。上限は FK 列集合**全体**が
  主キーまたは UNIQUE 制約と一致するときだけ `1` → `0..1`、それ以外（複合主キーの一部だけを
  参照している場合も含む）→ `0..N`

例（`examples/er/sample-schema/ecommerce.sql`）:

| 関係 | 根拠 | cardinality |
|---|---|---|
| `users → addresses` | `user_id` NOT NULL / UNIQUE なし | `1:0..N` |
| `categories → categories` | `parent_id` NULL 許容 / UNIQUE なし | `0..1:0..N` |
| `users → profiles` | `user_id` NOT NULL / 単独 PK | `1:0..1` |

推定が実態と違う場合（例: 論理削除で NULL 許容だが実質必須）は JSON spec の
`relations[].cardinality` を直接修正する。

---

## レイアウトの決まる順序

1. `from → to` の参照方向から最長パス深度を計算（循環は打ち切り）し、`col`（列）の初期値にする。
2. 深さに余裕がある親は子の方へ引き寄せる（線が隣接列間だけになるよう最適化）。
3. 同じ列内は、すでに配置済みの隣接テーブル重心順に並べる（線の交差削減）。
4. `row` / `col` を指定したテーブルはそれらを優先する。
5. カラム幅・カード高さからキャンバスサイズを自動計算する。横ガター 110px・縦ガター 78px 以上を確保。

```bash
# スペックを編集して再描画する例
node scripts/drawio-cli.mjs er --spec examples/output/ecommerce-er.json \
  --output examples/output/ecommerce-er.drawio.png
```

---

