> 統合スキル `drawio-diagrams-skill` のうち **業務フロー（スイムレーン）図** を担当するリファレンス。
> 実行はすべて `node scripts/drawio-cli.mjs workflow ...` / `node scripts/drawio-cli.mjs png ...` 経由。

# スイムレーン付き作業フロー & 関連リソース動作の可視化スキル (`drawio-workflow`)

作業フローを実行したときに **「ユーザー操作 → 画面 / UI → バックエンド → ストレージ (RDS / S3 / DynamoDB / SQS 等)」** などの各レーンがどのように連動し、各ストレージや外部リソースのデータ・状態がどう変化するかを **横方向または縦方向のスイムレーン図（`.drawio` + `.drawio.png`）** として生成する。

出力される `.drawio.png` には draw.io XML（`zTXt` チャンク `mxGraphModel`）が埋め込まれているため、画像としてそのままチャットやドキュメントに貼れるほか、draw.io で開いて再編集できる。

---

## ステップ 0: 作成前のユーザー確認（必須）

図（JSON / XML）を作り始める前に、以下の2点を**必ずユーザーに確認する**（ユーザーのプロンプトで既に明示されている項目は省略してよい）：

1. **スイムレーンの向き（`direction`）**
   - **`horizontal`（横スイムレーン）**: 上から下へレーン行が並び、左から右へ時系列ステップが進む
   - **`vertical`（縦スイムレーン）**: 左から右へレーン列が並び、上から下へ時系列ステップが進む
2. **作成するレーン一覧（`lanes`）**
   - 対象となる業務・コードベースを踏まえ、推奨レーン案を提示して過不足・名称を確認する。
   - 基本の4レーン例：
     1. `ユーザー操作`（Actor / Trigger）
     2. `画面 / UI`（Web / Mobile App）
     3. `バックエンド`（API / Lambda / Worker）
     4. `ストレージ / リソース`（RDS / S3 / DynamoDB / SQS 等）
   - 必要に応じて `管理者操作`、`外部サービス（決済 / メール / 認証IdP）`、`バッチ / 非同期ワーカー` などの追加・分割を提案する。

---

## 実行手順（ハイブリッド方式）

### 方式1: JSON定義から自動整列したスイムレーンXML＋PNGを一括生成する（推奨）

ノード数が多いフローや複数ストレージ（RDS / S3 / DynamoDB / SQS 等）が絡むフローでは、座標計算や矢印の重なり回避を自動で行う `build-workflow.mjs` を使う。同じ JSON 仕様のまま `--direction horizontal` / `--direction vertical` で縦横を切り替えられる。

```bash
# 横スイムレーンで生成
node scripts/drawio-cli.mjs workflow \
  --spec /path/to/workflow.json \
  --direction horizontal \
  --output /path/to/workflow.drawio.png \
  --xml-out /path/to/workflow.drawio \
  --scale 2

# 縦スイムレーンで生成
node scripts/drawio-cli.mjs workflow \
  --spec /path/to/workflow.json \
  --direction vertical \
  --output /path/to/workflow-vertical.drawio.png \
  --xml-out /path/to/workflow-vertical.drawio \
  --scale 2
```

### 方式2: `.drawio` XML を直接記述・微調整して PNG / SVG に変換する

細かいカスタム配置や既存の `.drawio` ファイルを直接編集した場合は、単一ファイル完結の `drawio2png.mjs` で PNG 化する（`npm install` や `draw.io.app` 不要）。

```bash
node scripts/drawio-cli.mjs png \
  /path/to/diagram.drawio \
  -o /path/to/diagram.drawio.png \
  --scale 2 --border 16 --embed-xml

# 編集した図の文字と線の重なりを機械検査（終了コード 0 が正常）
node scripts/check-layout.mjs /path/to/diagram.drawio
```

---

## 日本語ラベルの安全な出し方（`build-workflow.mjs` が守る規約）

日本語の長いラベルは、置き方を工夫しないと線や他の図形の上を横切って「線が消えて見える」原因になる。スキルの生成側は次を自動で行うため、XML を直接書くときも同じ規約に従う。

1. **エッジラベルはエッジの `value` に書かない**。`<mxCell id="e1_lbl" style="edgeLabel;..." vertex="1" connectable="0" parent="e1">` の子セルとして出し、`<mxGeometry>` に **折返し幅の `width`/`height`** を必ず持たせる。幅を持たないラベルは折り返し幅が未確定のまま1本の長文になり、他のレーンまで横切る。
2. **ラベルの位置は「線上の点 + オフセット」で決める**。draw.io は `relative` な `x`（-1〜1 → 線分上の位置）で求めた点上に、`<mxPoint as="offset">` を **ラベル箱の左上**として置く。中心基準で置きたい場合は `offset = 中心基準のずれ - 箱の半分` に読み替える。
3. **レーンの見出しを `swimlane` 本体の `value` に置かない**。`horizontal=0` のレーンでは日本語が 90° 回転して縦読みに見えるため、`value=""` にして `text;html=1;` の子セルで横書きする（詳細は 本ドキュメント末尾の XML 直接記述ガイド）。

---

## 関連リソース可視化のルール

1. **「関連リソースがどう動くか」の明示（必須）**
   - 単に「RDS」「S3」「DynamoDB」のアイコンを置くだけでなく、**その作業フローを実行したときにリソース内部で起きる変化**を必ずセットで描く：
     - **コネクタ（矢印）の種別とラベル**:
       - `type: "write"`（太い赤茶色の実線矢印）: `⑥ TX COMMIT`、`⑦ PutObject`、`INSERT / UPDATE`
       - `type: "read"`（青の破線矢印）: `④ GetItem / Lock`、`SELECT`
       - `type: "async"`（オレンジの破線矢印）: `⑧ SendMessage (Enqueue)`、`⑨ Poll / Subscribe`
       - `type: "response"`（グレーの破線矢印）: `⑩ 200 OK (order_id)`
     - **リソース状態変化ノート（`effect` / `effectTitle`）**:
       - 各ストレージノード直下に黄色いノート（`shape=note`）を配置し、具体的なテーブル名・キー・状態遷移を箇条書きする：
         - **RDS の例**: `INSERT orders (status='PAID')` / `UPDATE inventory SET stock = stock - 1`
         - **DynamoDB の例**: `GetItem: cart_id` / `UpdateItem: state = LOCKED → COMPLETED (TTL更新)`
         - **S3 の例**: `PutObject: s3://receipts/{order_id}.pdf (SSE-S3暗号化)`
         - **SQS / SNS の例**: `SendMessage: OrderConfirmedEvent` / `NotifyWorker が非同期消費`

2. **時系列フェーズバー（`phases`）とステップ番号（`step` / `① ② ③`）**
   - 横スイムレーンでは図の上部に、縦スイムレーンでは図の左側に `Phase 1: ...`, `Phase 2: ...` の見出しバーが自動配置される。各ノードに `step: "1"`（`[1]`）、各矢印に `①` `②` `③` の通し番号をつけて処理順序を一目で追えるようにする。

---

## ワークフロー作成のステップ

1. **ユーザーへ方向とレーン構成を確認する（ステップ 0）**
   - `horizontal`（横）か `vertical`（縦）か、および作成するレーン一覧（追加・削除・名称）を確認する。
2. **フローと関連リソースの整理**
   - 確定したレーンに沿って、登場する操作・画面・バックエンド処理・ストレージ（RDSテーブル、S3バケット、DynamoDBテーブル、キュー等）を時系列ステップ（`col` / `row`: `0, 1, 2...`）に割り振る。
3. **JSON仕様の作成（または XML の直接生成）**
   - JSON スキーマの詳細は 本ドキュメント末尾の JSON スキーマ仕様 を参照。
   - 手書き・カスタム XML で調整する場合は 本ドキュメント末尾の XML 直接記述ガイド を参照。
   - 完全なサンプルは [examples/workflow/order-checkout-workflow.json](../examples/workflow/order-checkout-workflow.json) を参照。
4. **`.drawio` + `.drawio.png` のビルド**
   - `build-workflow.mjs`（または `drawio2png.mjs`）を実行して `.drawio.png` を生成する。
   - `build-workflow.mjs` は生成後に図を実測し、文字が線・ノード・レーン枠と重なっていないか自己検査して結果を表示する（`レイアウト検査: ...`）。
5. **機械検査 → 目視検証の順で仕上げる（必須）**
   - 機械検査:

     ```bash
     node scripts/check-layout.mjs /path/to/workflow.drawio
     ```

     終了コード 0 なら「文字は線・ノード・レーン枠と交差していない」。1 のときは指摘されたエッジの `labelWidth` / `labelPosition` / `labelRatio`、または `colPitch` を調整して作り直す。
   - 目視検証: 生成された `.drawio.png` を画像として読み込み（`read_file`）、ラベル切れ・線と文字の重なり・枠からはみ出したノートがないか確認してからユーザーに提示する。機械検査を通っても、ラベルが密集して読みにくい場合はステップ間隔を広げて作り直す。

---

# workflow-schema.md — `build-workflow.mjs` JSON スキーマリファレンス

`scripts/build-workflow.mjs` に渡す JSON ファイルの構造リファレンスです。

---

## トップレベル構造

```json
{
  "title": "図全体のタイトル",
  "subtitle": "サブタイトル（対象システムやフローの概要）",
  "direction": "horizontal",
  "colPitch": 250,
  "phases": [ ... ],
  "lanes": [ ... ],
  "nodes": [ ... ],
  "edges": [ ... ]
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `title` | `string` | Yes | 図上部のタイトルバナーに表示するメインタイトル |
| `subtitle` | `string` | No | タイトルバナー2行目の説明文 |
| `direction` | `"horizontal" \| "vertical"` | No | スイムレーンの向き。`horizontal`（横・デフォルト）または `vertical`（縦）。CLI の `--direction` で上書き可能 |
| `colPitch` | `number` | No | 横スイムレーン時の1ステップ列あたりの横幅px（デフォルト: `250`） |
| `phases` | `Array<Phase>` | No | 横モード時は上部、縦モード時は左側に表示するフェーズ見出しバー |
| `lanes` | `Array<Lane>` | No | スイムレーン定義（省略時は `user`, `screen`, `backend`, `storage` の4レーン） |
| `nodes` | `Array<Node>` | Yes | 各レーン・各ステップ（`col` または `row`）に配置するノード（操作・画面・API・DB/S3等） |
| `edges` | `Array<Edge>` | Yes | ノード間の遷移・API呼び出し・データ読み書きコネクタ |

---

## 1. `phases`（上部フェーズバー）

```json
{
  "col": 0,
  "fromCol": 0,
  "toCol": 1,
  "label": "Phase 1: 入力・バリデーション",
  "fillColor": "#e8f0fe",
  "strokeColor": "#6c8ebf"
}
```
- 単一列の場合は `"col": 0`、複数列にまたがるフェーズの場合は `"fromCol": 0, "toCol": 1` を指定できます。

---

## 2. `lanes`（スイムレーン定義）

省略時は以下の4レーンが自動生成されます。カスタムレーンを追加・変更する場合のみ指定してください。

| `id` | デフォルト `title` | 用途 |
|---|---|---|
| `user` | `ユーザー操作` | アクター（購入者・管理者・外部システム）と操作トリガー |
| `screen` | `画面 / フロントエンド` | Web画面・モバイル画面・モーダル・UI状態変化 |
| `backend` | `バックエンド` | API Gateway・Controller・Lambda・ECS/EKS・判定ロジック |
| `storage` | `ストレージ / リソース` | RDS (PostgreSQL/MySQL)・DynamoDB・S3・SQS・SNS・Redis 等 |

---

## 3. `nodes`（ノード & リソース状態変化定義）

```json
{
  "id": "st_rds",
  "lane": "storage",
  "col": 2,
  "kind": "rds",
  "step": "6",
  "label": "Aurora PostgreSQL",
  "subtitle": "orders / inventory",
  "effectTitle": "RDS トランザクション",
  "effect": [
    "INSERT orders (status='PAID')",
    "INSERT order_items (明細行)",
    "UPDATE inventory SET stock = stock - 1"
  ]
}
```

### 利用可能な `kind` 一覧

| カテゴリ | `kind` | 描画される draw.io シェイプ / アイコン |
|---|---|---|
| **ユーザー操作** | `actor` | UML アクター（人型アイコン + 下部ラベル） |
| **ユーザー操作** | `action` | 角丸アクションカード（水色） |
| **画面 / UI** | `screen` | 画面ボックス（緑系・角丸・シャドウ付き） |
| **画面 / UI** | `modal` | 二重枠モーダル / ダイアログボックス |
| **バックエンド** | `process` | 汎用処理ボックス（黄色系・角丸） |
| **バックエンド** | `service` | サービス処理ボックス（左右縦線入り `shape=process`） |
| **バックエンド** | `decision` | 条件分岐ひし形（`rhombus`） |
| **バックエンド** | `apigw` | AWS API Gateway 公式ステンシルアイコン |
| **バックエンド** | `lambda` | AWS Lambda 公式ステンシルアイコン |
| **バックエンド** | `k8s` | Kubernetes Pod 公式ステンシルアイコン |
| **バックエンド** | `ecs` | AWS ECS 公式ステンシルアイコン |
| **バックエンド** | `external` | 外部クラウド / 外部API（`shape=cloud`） |
| **ストレージ** | `rds` | DBシリンダー（`shape=cylinder3`） |
| **ストレージ** | `dynamodb` | Amazon DynamoDB 公式ステンシルアイコン |
| **ストレージ** | `s3` | Amazon S3 公式ステンシルアイコン |
| **ストレージ** | `sqs` | Amazon SQS 公式ステンシルアイコン |
| **ストレージ** | `sns` | Amazon SNS 公式ステンシルアイコン |
| **ストレージ** | `redis` | Amazon ElastiCache (Redis) 公式ステンシルアイコン |
| **補足メモ** | `note` | ノート図形（`shape=note`） |

### リソース動作の可視化プロパティ（`effect` / `effectTitle`）
- `effect` に文字列の配列を指定すると、そのノードの直下（`"effectPosition": "right"` 指定時は右側）に黄色いノート図形（`shape=note`）が自動配置され、テーブル行の追加・ステータス更新・S3オブジェクト生成・キュー投入などの具体的なリソース挙動が表示されます。

---

## 4. `edges`（コネクタ・データフロー定義）

```json
{
  "from": "b_order_lambda",
  "to": "st_rds",
  "type": "write",
  "label": "⑥ TX COMMIT"
}
```

### エッジの `type` 一覧

| `type` | スタイル・色 | 用途 |
|---|---|---|
| `flow` | 黒/濃灰の実線 + 標準矢印 | 画面遷移・ボタン押下・同期APIリクエスト |
| `write` | 赤茶色（`#b85450`）の太実線 + 塗りつぶしブロック矢印 | DBへの `INSERT`/`UPDATE`/`DELETE`、S3への `PutObject` |
| `read` | 青（`#0066CC`）の破線 + オープン矢印 | DBからの `SELECT`、DynamoDB `GetItem`、S3 `GetObject` |
| `async` | オレンジ（`#d79b00`）の破線 + 標準矢印 | SQS `SendMessage` / `Poll`、SNS Publish、非同期ジョブ起動 |
| `response` | グレー（`#666666`）の細破線 + オープン矢印 | APIレスポンス返却（`200 OK` 等） |

### ラベルの折返しと位置（長い日本語ラベル用）

デフォルトではラベルの折返し幅と位置を自動計算する。線や図形に当たる場合は以下で上書きできる。

| フィールド | 型 | 既定 | 説明 |
|---|---|---|---|
| `labelWidth` | `number` | 自動（84〜168px） | ラベル箱の折返し幅px。語の途中で折り返したくない語があるときは広めにする |
| `labelPosition` | `"auto" \| "center" \| "left" \| "right"` | `"auto"` | 線の進行方向に対して左側／右側に寄せる。`center` は線の上に白い背景で重なる（最終手段） |
| `labelRatio` | `number`（-1〜1） | 自動 | 線上の基準点。`-1` が始点、`0` が中央、`1` が終点 |

```json
{ "from": "st_sqs", "to": "st_notify", "type": "async", "label": "⑨ Poll: OrderConfirmedEvent", "labelWidth": 132, "labelPosition": "left", "labelRatio": -0.34 }
```

`node scripts/check-layout.mjs <図面>` を実行すると、実際に描画されるラベル枠を測って「線と文字」「文字とノード」「文字とレーン枠」の重なりを指摘する（終了コード 0=指摘なし / 1=重なり候補 / 2=入力エラー）。
自分の線の途中に置いたラベル、大きい枠の中にすっぽり収まるラベルは指摘しない。破線枠の辺をまたぐラベルなど、
可読性に問題がないものも 1 になることがあるため、最終判断は PNG の目視で行う。`build-workflow.mjs` も生成後に同じ検査を自動で行う。

---

# swimlane-xml-guide.md — 横スイムレーン `.drawio` XML 直接記述ガイド

`build-workflow.mjs` で生成した `.drawio` ファイルを微調整する場合や、LLM が直接 `.drawio` XML を組み立てる場合の座標・スタイル規約です。

> **生成されるセル ID の形式**: `build-workflow.mjs` は図中のすべてのセル ID を
> `diagram-shared.mjs` の `createCellIdMap()`（1 本の共有アロケータ）で採番します。
> 生成物では レーン = `lane-<laneId>`、レーン見出し = `lane-<laneId>_hdr`、
> ノード = `node-<nodeId>`、効果ブロック = `effect-<nodeId>`、エッジ = `edge-<edgeId>`、
> エッジラベル = `edge-<edgeId>~lbl`、固定セル = `title_banner` / `phase_<i>` の形になります。
> レーン ID とノード ID が `team` と `lane_team` のように衝突しても、アロケータが
> `_2` の連番を付けて二重定義を防ぎます。下の `lane_storage` / `st_rds_effect` は
> 手書き XML 用の説明例なので、生成ファイルを直接編集するときは実ファイルの実際の ID を
> `parent` / `source` / `target` に書いてください。

---

## 1. 横スイムレーン（左ヘッダー＋水平レーン）の XML パターン

draw.io の標準 `swimlane;horizontal=0;startSize=165;` を使うと左側に幅 165px のヘッダー領域が作られます。
日本語のレーン名を回転させず**横書き**で読みやすく表示するため、スイムレーン本体の `value=""` は空にし、子要素として左ヘッダー領域（`x="6" y="0" width="153"`）に `text;html=1;` セルを配置します。

```xml
<!-- 横スイムレーン本体 (parent="1") -->
<mxCell id="lane_storage" value="" style="swimlane;horizontal=0;startSize=165;fillColor=#e1d5e7;strokeColor=#9673a6;swimlaneFillColor=#fcfaff;strokeWidth=1.5;" vertex="1" parent="1">
  <mxGeometry x="40" y="520" width="1180" height="280" as="geometry" />
</mxCell>

<!-- 左ヘッダー内の横書きタイトル (parent="lane_storage") -->
<mxCell id="lane_storage_hdr" value="&lt;b style=&quot;font-size:13px&quot;&gt;ストレージ / リソース&lt;/b&gt;&lt;br&gt;&lt;font color=&quot;#555555&quot; style=&quot;font-size:11px&quot;&gt;RDS / S3 / DynamoDB / SQS&lt;/font&gt;" style="text;html=1;align=center;verticalAlign=middle;whiteSpace=wrap;connectable=0;" vertex="1" parent="lane_storage">
  <mxGeometry x="6" y="0" width="153" height="280" as="geometry" />
</mxCell>
```

> **重要**: レーン内の各ノードは `parent="lane_storage"` を指定し、座標 `(x, y)` は**レーン左上からの相対座標**（`x >= 190`）で指定します。

---

## 2. ストレージ・クラウドリソースの主要 XML スニペット

### Aurora / RDS (Cylinder3 + トランザクション状態変化ノート)
```xml
<mxCell id="st_rds" value="&lt;b&gt;Aurora PostgreSQL&lt;/b&gt;&lt;br&gt;orders / inventory" style="shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=11;fillColor=#dae8fc;strokeColor=#6c8ebf;shadow=1;" vertex="1" parent="lane_storage">
  <mxGeometry x="650" y="25" width="145" height="82" as="geometry" />
</mxCell>
<mxCell id="st_rds_effect" value="&lt;b&gt;RDS トランザクション&lt;/b&gt;&lt;br&gt;• INSERT orders (status=&apos;PAID&apos;)&lt;br&gt;• UPDATE inventory SET stock = stock - 1" style="shape=note;whiteSpace=wrap;html=1;backgroundOutline=1;size=12;fillColor=#ffffc0;strokeColor=#b59b00;fontSize=11;align=left;spacingLeft=6;shadow=1;" vertex="1" parent="lane_storage">
  <mxGeometry x="622" y="120" width="200" height="75" as="geometry" />
</mxCell>
```

### Amazon S3 / DynamoDB / SQS / Lambda / API Gateway
```xml
<!-- Amazon S3 -->
<mxCell id="st_s3" value="&lt;b&gt;Amazon S3 (Receipts)&lt;/b&gt;" style="outlineConnect=0;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.s3;fillColor=#277116;strokeColor=#ffffff;" vertex="1" parent="lane_storage">
  <mxGeometry x="692" y="220" width="60" height="60" as="geometry" />
</mxCell>

<!-- Amazon DynamoDB -->
<mxCell id="st_dynamo" value="&lt;b&gt;DynamoDB (Sessions)&lt;/b&gt;" style="outlineConnect=0;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.dynamodb;fillColor=#C925D1;strokeColor=#ffffff;" vertex="1" parent="lane_storage">
  <mxGeometry x="442" y="25" width="60" height="60" as="geometry" />
</mxCell>

<!-- Amazon SQS -->
<mxCell id="st_sqs" value="&lt;b&gt;Amazon SQS (Events)&lt;/b&gt;" style="outlineConnect=0;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.sqs;fillColor=#D9A741;strokeColor=#ffffff;" vertex="1" parent="lane_storage">
  <mxGeometry x="942" y="25" width="60" height="60" as="geometry" />
</mxCell>
```

---

## 3. アイコン下部ラベルと矢印が重ならないための鉄則

`verticalLabelPosition=bottom;verticalAlign=top;` を持つアイコン（`umlActor`, `mxgraph.aws4.resourceIcon`, `mxgraph.kubernetes.icon2` 等）は、アイコン本体の下（`+38px`）にテキストラベルが描画されます。
そのアイコンから**下向きに矢印を出す場合**は、スタイルに以下を指定してラベルの下から矢印を開始させてください：

```
exitX=0.5;exitY=1;exitDx=0;exitDy=38;exitPerimeter=0;
```

同様に、下からアイコンへ矢印が入る場合は以下を指定します：

```
entryX=0.5;entryY=1;entryDx=0;entryDy=38;entryPerimeter=0;
```

---

## 4. `horizontal` と `vertical` の命名と「90° 回転」の落とし穴

`swimlane` の `horizontal` は**ヘッダーの向き**を表すフラグで、レーンの並び方向ではない。名前の罠に注意する。

| スキルの `--direction` | `swimlane` のスタイル | ヘッダーの位置 | 見出しの出し方 |
|---|---|---|---|
| `horizontal`（横レーン行） | `horizontal=0` | 各レーンの左端 | **空の `value`** ＋ `text;html=1;` 子セル（下記 §1） |
| `vertical`（縦レーン列） | `horizontal=1` | 各レーンの上端 | `value` に直接書いてよい（回転しない） |

`horizontal=0` の `swimlane` に日本語の `value` を入れるとラベルが 90° 回転して描画され、日本語が縦読みに見えて非常に読みにくい。**回転するレーンに直接 `value` を置かない**のが鉄則で、`build-workflow.mjs` はこの方式で生成する。

---

## 5. エッジラベル（特に長い日本語ラベル）の安全な書き方

エッジの `value` に直接ラベルを書くと、ラベルは折返し幅を持たず（描画実測で `width=0`／`height=0`）改行されない1本の長文になる。日本語の長いラベルは他のレーンや図形を横切り、線を消して見える。必ず幅を持つ子セルとして出す。

```xml
<!-- エッジ本体は value を空にする -->
<mxCell id="e2" value="" style="edgeStyle=orthogonalEdgeStyle;html=1;endArrow=block;exitX=1;exitY=0.5;" edge="1" parent="1" source="n1" target="n2">
  <mxGeometry relative="1" as="geometry" />
</mxCell>

<!-- ラベルは子セルとして、折返し幅 width と高さ height を持つ -->
<mxCell id="e2_lbl" value="② 同一トランザクション内で注文本体と明細行を確定" style="edgeLabel;html=1;align=center;verticalAlign=middle;resizable=0;fontSize=11;labelBackgroundColor=#ffffff;whiteSpace=wrap;" vertex="1" connectable="0" parent="e2">
  <mxGeometry x="-0.1" y="0" relative="1" as="geometry" width="132" height="45">
    <mxPoint x="-66" y="-50" as="offset" />
  </mxGeometry>
</mxCell>
```

- `width` / `height` は**折返し後の実測高さを収める**（この例では幅 132px で 3 行＝約 39px なので 45px）。高さが足りないと文字が箱の下へはみ出して線にかかる。
- `mxGeometry` の `x`（-1〜1）が線上の基準点、`as="offset"` の `mxPoint` が**その点からラベル箱の左上までのずれ**である。中心を置きたい位置を `dx, dy` として表すなら `x座標 = dx - width/2`、`y座標 = dy - height/2` を書く（ここを間違えるとラベルが線の上に残る）。
- `labelBackgroundColor=#ffffff` は文字幅 + 3px の白い箱を描く。衝突検査はこの白い箱の実際のサイズで行う。
- `whiteSpace=wrap` を付け忘れると `width` を持っても折り返さない。
- 実際に描画される枠は `node scripts/check-layout.mjs <図面>` で測れる（折返さないラベルは `mxText` の `bounds` より広く描かれるため、`bounds` をそのまま衝突判定に使ってはいけない）。

---

