> 統合スキル `drawio-diagrams-skill` のうち **UML クラス図** を担当するリファレンス。
> 実行はすべて `node scripts/drawio-cli.mjs class ...` / `node scripts/scan-classes.mjs ...` 経由。

# UML クラス図生成スキル (`drawio-class`)

JSON spec を描画して `.drawio` XML および `.drawio.png`（元XML埋め込み済み・draw.io再編集可能）を
生成する。Pure Node.js (.mjs) のみで動作し、外部 npm 依存はゼロ。
`scripts/scan-classes.mjs` は `.ts` / `.js` ソースを正規表現 + カーリー括弧トラバースで簡易解析し、
クラス・メンバー・継承関係を JSON spec に変換する。

---

## デフォルトの描画方針

- **レイアウト**: spec の `row` / `col` を優先。未指定のクラスは stereotype から自動 tier 配置
  （interface / abstract → 上段、entity / service → 中段、enum / value object → 下段）。
  水平間隔 90px 以上、垂直間隔 80px 以上を確保。
- **関係線のスタイル**:
  - 継承 / 実装: 白抜き三角 (`endArrow=block;endFill=0`)、実装は破線
  - 合成: 塗り diamonds (`startArrow=diamondThin;startFill=1`)
  - 集約: 白抜き diamond (`startFill=0`)
  - 関連 / 依存: 実線 open arrow / 破線矢印
  - 多重度はソース・ターゲット両端に `labelBackgroundColor=#FFFFFF` 付きで描画
- **パッケージ**: `classes[].package` または `packages[]` を破線枠 + `«package»` ラベルで描画
- **ヘッダー**: 左端アクセントバー (#4F46E5) + 左寄せタイトル / サブタイトル + 細区切り線、
  右上に凡例（Extends/Implements・Composition・Aggregation・Association/Dependency）

---

## 実行手順

### 1. JSON spec から直接描画（最短1コマンド）

```bash
node scripts/drawio-cli.mjs class \
  --spec /path/to/class-spec.json \
  --output /path/to/class-diagram.drawio.png
```

`--output` から `.drawio` XML のパスを自動決定する（`xxx.drawio.png` → `xxx.drawio`）。
明示指定は `--xml-out`、タイトル上書きは `--title` / `--subtitle`、PNG解像度は `--scale`（既定 2）。
`--no-png` で XML のみ生成も可。`.svg` 出力は出力拡張子で自動判定。

### 2. ソースコードから 2 ステップ生成（スキャン → 補完 → 描画）

```bash
# (a) TypeScript / JavaScript をスキャンして spec を作る
node scripts/scan-classes.mjs --src-dir /path/to/src -o /path/to/class-spec.json
#     --packages を付けるとトップレベルフォルダ単位でパッケージ枠 + 行配置になる

# (b) 必要に応じて spec を編集（row/col 指定、stereotype、package、dependency 関係の追記）

# (c) 描画
node scripts/drawio-cli.mjs class --spec /path/to/class-spec.json -o /path/to/class-diagram.drawio.png
```

スキャンの既知の制限: 構文パーサーではないため複雑なジェネリクス・デコレータは荒く吸収する。
クラス宣言は行頭開始のみ抽出（関数内ローカルクラスは対象外）。`node_modules` / `dist` 等は自動スキップ。
`--src-dir` は `build-class.mjs` に直接渡すこともでき、その場合はスキャン → 描画を 1 コマンドで行う。

### 3. 目視検証（必須）
- 生成された `.drawio.png` を画像読み込みで確認し、ラベルの欠落・線とカードの重なり・
  レイアウト崩れをチェックしてからユーザーへ報告する。崩れがある場合は spec の `row` / `col` を
  調整して再生成する。

---

## リファレンス

- 本ドキュメント末尾のスペック仕様 — JSON spec の全フィールドと関係タイプ一覧

---

# JSON spec リファレンス (`drawio-class`)

`build-class.mjs --spec` に渡す JSON の形式。最上位キーは `title` / `subtitle` / `packages` /
`classes` / `relations`。必須は `classes` のみ（空配列はエラー）。

```json
{
  "title": "注文ドメインモデル",
  "subtitle": "1行の補足説明（任意）",
  "packages": [
    { "id": "domain", "label": "order.domain" }
  ],
  "classes": [ ... ],
  "relations": [ ... ]
}
```

## `classes[]` — クラスカード

| フィールド | 必須 | 説明 |
| --- | --- | --- |
| `id` | ○ | 図内一意の参照キー（`relations` から参照） |
| `name` | ○ | カード見出しに表示するクラス名 |
| `stereotype` | | `«...»` タグと配色。下表参照。既定 `default` |
| `package` | | 所属パッケージの `id`。`packages[]` に無い id を書くと暗黙にパッケージ枠を追加 |
| `row` / `col` | | グリッド配置（0 始まりの整数）。どちらか一方でも指定可。未指定は tier 自動配置 |
| `attributes` | | 属性セクションの行テキスト配列（`- id: OrderId` のように可視性記号を先頭に置く慣習） |
| `methods` | | メソッドセクションの行テキスト配列（`+ place(): void`） |

- 属性・メソッドが両方あるときは細い区切り線が入る。空のセクションは描画しない。
- カード幅は内容から自動計算（最小 190px、最大 340px。折り返しは概算推定）。
- `Promise<void>` のようなジェネリクス表記はそのまま書ける（ラベルは二重エスケープ済み）。

### stereotype パレット

| 値 | `«タグ»` | ヘッダー配色 | 備考 |
| --- | --- | --- | --- |
| `interface` | `«interface»` | 青緑 (`#CCFBF1` / `#0D9488`) | |
| `abstract` | `«abstract»` | 紫 (`#F3E8FF` / `#7C3AED`) | クラス名はイタリック |
| `enum` | `«enum»` | 琥珀 (`#FEF3C7` / `#D97706`) | |
| `value object` / `valueobject` / `vo` | `«value object»` | 水 (`#E0F2FE` / `#0284C7`) | |
| `dto` | `«dto»` | 水（同上） | |
| `entity` | `«entity»` | 藍 (`#EEF2FF` / `#3730A3`) | |
| `service` / `default` / その他 | `«service»` 等 | 藍（同上） | 未知の値は `«値»` そのまま表示 |

自動 tier 配置（`row` 未指定時）: `interface` / `abstract` → 上段、`entity` / `service` / 既定 → 中段、
`enum` / `value object` / `dto` → 下段。

## `relations[]` — 関係線

| フィールド | 必須 | 説明 |
| --- | --- | --- |
| `from` | ○ | ソース側クラス `id`（菱形・三角が付く側 / 矢印が出ない側） |
| `to` | ○ | ターゲットクラス `id`（矢印が付く側） |
| `type` | | 下表参照。既定 `association` |
| `label` | | 線の中点ラベル（`placedBy` などの動詞） |
| `sourceMultiplicity` | | `from` 端の多重度（`1` / `0..*` / `1..*`） |
| `targetMultiplicity` | | `to` 端の多重度 |

### 関係タイプ

| `type`（別名） | 描画 |
| --- | --- |
| `composition` | 実線 + 塗り diamond（`from` 側）+ open arrow |
| `aggregation` | 実線 + 白抜き diamond（`from` 側）+ open arrow |
| `association` | 実線 + open arrow |
| `inheritance`（`extends` / `generalization`） | 実線 + 白抜き三角（`to` 側） |
| `implementation`（`implements` / `realize`） | 破線 + 白抜き三角（`to` 側） |
| `dependency`（`uses`） | 破線 + open arrow |

- 配線は orthogonal ルーティングで、同一辺に複数エッジが寄る場合はポート位置を分散させる。
- 直線経路が他カードを横切るときは行間の空白帯を走る回避ウェイポイントを自動投入する。

## `packages[]` — パッケージ破線枠（任意）

| フィールド | 必須 | 説明 |
| --- | --- | --- |
| `id` | ○ | `classes[].package` から参照される id |
| `label` | | 枠内左上に表示するラベル（既定は `id`） |

枠は所属クラスの外接矩形を内包するよう自動計算される（左右 26px・上 48px・下 26px の余白）。
`packages[]` を書かなくても `classes[].package` だけで暗黙に枠が生成される。

## スキャナ出力との対応

`scan-classes.mjs` は次を変換して出力する。

- `class` → `stereotype: "default"`（`abstract` 修飾なら `"abstract"`）
- `interface` → `stereotype: "interface"`、`enum` → `stereotype: "enum"`（定数は `attributes`）
- `extends` → `type: "inheritance"`（継承先が interface の推定時は `implementation`）
- `implements` → `type: "implementation"`
- 可視性は `+` / `-` / `#` 接頭辞、静的メンバーは `{static}` タグ付き
- コンストラクタの引数プロパティ（`constructor(private x: T)`）は属性へ展開

---

