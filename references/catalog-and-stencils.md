> `drawio-diagrams-skill` の **図種カタログ + シンボル / ステンシル実測一覧**。
> 「どの図種を選ぶか」「既定シェイプで足りないときにどんな `shape=` が使えるか」
> 「手書き `.drawio` XML をどう PNG にするか」を 1 本で決めるための決定版リファレンス。
> 掲載している個数はすべて `scripts/drawio2png.mjs` の `getDrawioOssRuntime()` を
> 実行して実測した値（環境が変われば再測すること）。

# 1. 図種 8 種の早見表

| kind | サブコマンド | 入力 | 向いている場面 | 自動スキャン | サンプル出力 |
| --- | --- | --- | --- | --- | --- |
| `workflow` | `workflow` | JSON spec（レーン + ステップ） | 業務フロー / 役割横断の手順 / 画面〜API〜DB の連動 | – | `examples/output/workflow-horizontal.drawio.png` |
| `aws-arch` | `aws-arch` | Terraform ディレクトリ | AWS 構成の全体像（公式 AWS4 アイコン） | `.tf` パーサ内蔵 | `examples/output/aws-arch-default.drawio.png` |
| `sequence` | `sequence` | JSON spec（ライフライン + メッセージ） | API 呼び出し順 / 非同期フロー / 例外分岐 | – | `examples/output/order-checkout-sequence.drawio.png` |
| `class` | `class` | JSON spec or ソースディレクトリ | ドメインモデル / 型設計レビュー | `--src-dir`（TS / JS） | `examples/output/order-domain-class.drawio.png` |
| `er` | `er` | SQL DDL / Prisma / JSON | テーブル設計・外部キー・基数の確認 | `.sql` / `.prisma` パーサ内蔵 | `examples/output/ecommerce-er.drawio.png` |
| `state` | `state` | JSON spec（状態 + 遷移） | オーダステータス等のライフサイクル / ガード付き遷移 | – | `examples/output/order-lifecycle-state.drawio.png` |
| `c4` | `c4` | JSON spec（要素 + 境界 + 関係） | Container 段のシステム構成 / プロトコル可視化 | – | `examples/output/ecommerce-c4-container.drawio.png` |
| `screen-flow` | `screen-flow` | JSON spec（画面 + 遷移） | 画面遷移・モーダル / エラー分岐・権限区分 | – | `examples/output/admin-portal-screen-flow.drawio.png` |
| （汎用） | `png` | 任意の `.drawio` / `.xml` / `.drawio.png` | 手書き XML の変換・再変換・XML 抜出 | – | 任意 |

- 全サブコマンド共通: `-o/--output`（`.drawio.png` / `.svg` を指定すると同名 `.drawio` を隣に置く）、
  `--xml-out`、`--scale`（既定 2）、`--help`。それ以外のオプションは図種固有なので、
  使うサブコマンドの `--help` を確認する。
- `--title` / `--subtitle`: `workflow` と `png` を除く 7 図種（spec 内の `title` / `subtitle` より CLI が優先）。
- `--no-png`（XML のみ生成し画像変換を省く）: `class` / `state` / `c4` / `screen-flow` の 4 図種だけ。
  この 4 つは `--border` / `--theme` 非対応（余白・テーマはビルダー既定に固定）。
- `--border`（余白 px）/ `--theme light|dark`: `er` / `workflow` / `aws-arch` / `sequence` / `png` のみ。
- 個別オプション: `class --src-dir` / `--name`、`er --schema` / `--json-out` / `--follow-symlinks`、
  `aws-arch --tf-dir` / `--include` / `--json-out`、`workflow --direction`、
  `state` / `c4` / `screen-flow` の `--name`、
  `png --page` / `--all-pages` / `--list-pages` / `--bg` / `--transparent` / `--dpi` /
  `--embed-xml` / `--no-embed-xml` / `--extract-xml` / `--format`。
- 実測した在庫・寸法は次章以降。図種ごとの spec 詳細は
  `references/workflow.md` / `aws-arch.md` / `sequence.md` / `class.md` / `er.md` /
  `state.md` / `c4.md` / `screen-flow.md` を読む。

```bash
# 8 種まとめて生成（このスキルで最もよく使う 1 コマンド）
npm run demo

# 1 種だけ / PNG を別解像度で作り直す
node scripts/drawio-cli.mjs state --spec examples/state/order-lifecycle.json -o out.drawio.png
node scripts/drawio-cli.mjs png out.drawio -o out.drawio.png --scale 3 --bg "#FFFFFF"
```

---

# 2. 描画エンジンが持つシンボル在庫（実測）

`scripts/drawio2png.mjs` は draw.io OSS のシェイプ定義を単一ファイルに埋め込んでいる。
ネットワーク取得も `mxUrlConverter` による外部画像読み込みもしない（同一パスをそのまま返すだけ）。

```bash
node -e 'const m=await import("./scripts/drawio2png.mjs");const rt=await m.getDrawioOssRuntime();console.log(Object.keys(rt).join(", "))'
# → ctx, lightStyles, darkStyles, createSvgCanvas
```

## 2.1 既定シェイプ（遅延ロード不要で必ず描ける）

| 項目 | 実測値 |
| --- | --- |
| `mxCellRenderer.defaultShapes` のキー総数 | **772** |
| うち `mxgraph.*` プレフィックス付き | 680 |
| うちプレフィックスなしプリミティブ | 92 |

### プレフィックスなしプリミティブ 92 種（`shape=` にそのまま書ける）

`actor` `arrow` `arrowConnector` `associativeEntity` `callout` `card` `cloud` `collate`
`component` `connector` `corner` `cross` `crossbar` `cube` `curlyBracket` `cylinder` `cylinder2`
`cylinder3` `dataStorage` `datastore` `delay` `dimension` `display` `document` `doubleArrow`
`doubleEllipse` `ellipse` `endState` `ext` `filledEdge` `flexArrow` `folder` `hexagon` `image`
`internalStorage` `isoCube` `isoCube2` `isoRectangle` `label` `line` `lineEllipse` `link`
`lollipop` `loopLimit` `manualInput` `message` `module` `note` `note2` `offPageConnector` `or`
`orEllipse` `parallelMarker` `parallelogram` `partialRectangle` `pipe` `plus` `process` `process2`
`providedRequiredInterface` `rectangle` `requiredInterface` `requires` `rhombus` `singleArrow`
`sortShape` `startState` `step` `sumEllipse` `swimlane` `switch` `table` `tableLine` `tableRow`
`tape` `tapeData` `tee` `transparent` `trapezoid` `triangle` `umlActor` `umlBoundary`
`umlControl` `umlDestroy` `umlEntity` `umlFrame` `umlLifeline` `umlState` `waypoint` `wire`
`xor` `zigzag`

### 既定シェイプになっている `mxgraph.*` プレフィックス（組込み数）

| プレフィックス | 数 | プレフィックス | 数 | プレフィックス | 数 |
| --- | --- | --- | --- | --- | --- |
| `mxgraph.mockup.*` | 100 | `mxgraph.basic.*` | 34 | `mxgraph.eip.*` | 7 |
| `mxgraph.ios.*` | 58 | `mxgraph.lean_mapping.*` | 29 | `mxgraph.dfd.*` | 6 |
| `mxgraph.aws3d.*` | 57 | `mxgraph.floorplan.*` | 28 | `mxgraph.pid2inst.*` | 6 |
| `mxgraph.electrical.*` | 54 | `mxgraph.ios7ui.*` | 22 | `mxgraph.aws4.*` | 5 |
| `mxgraph.archimate3.*` | 51 | `mxgraph.bootstrap.*` | 22 | `mxgraph.c4.*` | 4 |
| `mxgraph.sysml.*` | 44 | `mxgraph.infographic.*` | 22 | `mxgraph.cabinets.*` | 4 |
| `mxgraph.er.*` | 12 | `mxgraph.arrows2.*` | 21 | `mxgraph.uml25.*` | 4 |
| `mxgraph.bpmn.*` | 11 | `mxgraph.rackGeneral.*` | 20 | `mxgraph.gcp2.*` | 2 |
| `mxgraph.gmdl.*` | 11 | `mxgraph.android.*` | 19 | `mxgraph.kubernetes.*` | 2 |
| `mxgraph.archimate.*` | 9 | \|その他（`emoji` `ibm` `sap` `atlassian` `cisco19` `cisco_safe` | \|1 ずつ） | `mxgraph.networks.*` | 2 |

**重要**: `mxgraph.aws4.*` の組込みは 5 種
（`group` / `group2` / `groupCenter` / `productIcon` / `resourceIcon`）だけで、
`mxgraph.aws4.lambda` のような個別アイコンは遅延ロード側の 1,037 種側に入る。
`build-aws-arch.mjs` は組込みの `resourceIcon` に `resIcon=mxgraph.aws4.lambda` を添える書き方を
取っており、これで橙色の角丸 + Lambda のグリフまで描ける（実写確認済み）。
遅延ロードは実際に動くので `shape=mxgraph.aws4.lambda` を直接指定しても描けるが、
`resourceIcon` 経由のほうが背景色・ラベル位置が揃い、公式 CDA 図に近い見た目になる。

## 2.2 遅延ロードされるステンシルライブラリ

`mxStencilRegistry.libraries` に **42 ライブラリ / 49 個の XML ファイル**が登録され、
うち **48 ファイル（`sap.xml` を除く全部）が埋め込み済み**で展開できる。
一意なステンシル定義数は **4,095**（`aws4b` / `bpmn2` などエイリアス重複込みのライブラリ合計は 5,417）。

| ライブラリ | シェイプ数 | ライブラリ | シェイプ数 |
| --- | --- | --- | --- |
| `aws4`（`aws4b` も同内容） | 1037 | `kubernetes` | 79 |
| `cisco_safe` | 485 | `electrical/*`（6 ファイル合計） | 212 |
| `veeam2` | 449 | `cabinets` | 53 |
| `veeam` | 333 | `ios7ui` | 53 |
| `gcp2` | 297 | `android` | 49 |
| `cisco19` | 232 | `floorplan` | 44 |
| `ios7icons` | 115 | `bpmn`（`bpmn2` も同内容） | 39 |
| `networks2` | 115 | `eip` | 36 |
| `ibmcloud` | 110 | `flowchart` | 34 |
| `gmdl` | 104 | `basic` | 30 |
| `salesforce` | 96 | `atlassian` / `rackGeneral` | 26 |
| `pid2misc` | 82 | `mockup/graphics` `mockup/misc` `mockup/navigation` | 22 ずつ |
| `networks` | 57 | `aws3d` / `pidFlowSensors` | 16 ずつ |
| `rackF5` | 25 | `lean_mapping` | 13 |
| `ibm` | 8 | `bootstrap` | 4 |

### 実際に描けることを確認済みのシェイプ（このスキルで実写検証済み）

| 用途 | `style` の書き方 |
| --- | --- |
| Kubernetes | `shape=mxgraph.kubernetes.pod;fillColor=#326CE5;strokeColor=none;`（`deploy` `svc` `ns` `ing` `node` `cm` `secret` `etcd` `master` `cronjob` `job` `hpa` `pv` `pvc` `crd` も同形） |
| GCP | `shape=mxgraph.gcp2.doubleRect;fillColor=#4285F4;` / `shape=mxgraph.gcp2.bigquery;fillColor=#4285F4;`（`gcp2` は 297 種） |
| C4 | `shape=mxgraph.c4.person2;fillColor=#08427B;strokeColor=none;`（`person` / `webBrowserContainer` もあり） |
| ER | `shape=mxgraph.er.entity;html=1;`（`entityExt` `attribute` `note` `chens` `bachmans`） |
| DFD | `shape=mxgraph.dfd.externalEntity;fillColor=#FFFFFF;`（`dataStoreID` `check2`） |
| BPMN | `shape=mxgraph.bpmn.shape;perimeter=ellipsePerimeter;outline=standard;symbol=task;` |
| EIP | `shape=mxgraph.eip.claim_check;fillColor=#FFFFFF;strokeColor=#333333;` |
| フローチャート | `shape=mxgraph.flowchart.document;html=1;`（34 種。`decision` `process` `terminator` 等） |
| ネットワーク | `shape=mxgraph.networks.bus;fillColor=#FFFFFF;` / `cisco19` は `fillColor=#036C96` を明示 |
| 汎用プリミティブ | `shape=cylinder3;size=12;` / `shape=swimlane;startSize=32;` / `shape=umlActor;` |

### 描画時の注意点（実測にに基づく）

- **`fillColor` / `strokeColor` を省略すると白抜けでほぼ見えない**ステンシルが多い
  （Kubernetes・GCP・Cisco 系は特に顕著）。ステンシルを使うときは必ず色を指定する。
- BPMN は `shape=mxgraph.bpmn.shape` に `outline` / `symbol` を組合せて描く。
  円形イベントは `perimeter=ellipsePerimeter` を付けないとクリック領域と外形がずれる。
- `mxStencilRegistry.dynamicLoading = true` / `allowEval = false`。
  JS を実行するタイプのステンシルは評価しない（安全側で形だけ描く）。
- 外部画像（`shape=image;image=https://...`）は取得しない。埋め込むなら
  `image=data:image/png;base64,...` を直接書く。

### 在庫を調べるときの第一歩は `shapes` サブコマンド

特定の名前が `shape=` に書けるか、似たシンボルが在るかはスクリプトを書かずに調べられる。
読み取り専用（ファイルもファイルも作らない）で、内蔵シェイプ・遅延ロードのステンシル・
矢印マーカーをまとめて検索する。

```bash
node scripts/drawio-cli.mjs shapes --query kubernetes            # 名前に kubernetes を含む候補
node scripts/drawio-cli.mjs shapes --query doubleBlock --kind marker
node scripts/drawio-cli.mjs shapes --kind shape --limit 0        # 内蔵シェイプを全件
```

`--kind` は `all`（既定）/ `shape`（内蔵シェイプ）/ `stencil`（遅延ロードのステンシル）/
`marker`（`endArrow` / `startArrow` の名前）。`--limit 0` で全件、既定 40 件。

手元で数を数え直したいときは次でもよい。

```bash
node - <<'JS'
import { getDrawioOssRuntime } from "./scripts/drawio2png.mjs";
const { ctx } = await getDrawioOssRuntime();
const shapes = ctx.mxCellRenderer.defaultShapes;
console.log("default shapes:", Object.keys(shapes).length);
const libs = ctx.mxStencilRegistry.libraries;
const files = new Set(Object.values(libs).flat());
let total = 0, ok = 0;
for (const f of files) {
  const xml = ctx.__inflateStencilXml(f);
  if (!xml) continue;
  ok++; total += (String(xml).match(/<shape /g) || []).length;
}
console.log("stencil files:", files.size, "embedded:", ok, "shapes:", total);
console.log("markers:", Object.keys(ctx.mxMarker.markers).length);
JS
```

---

# 3. 矢印マーカー 32 種（`endArrow` / `startArrow` に書ける名前）

`mxMarker.markers` に登録されている実測一覧。`startArrow=` にも同じ名前が使える。

| 系統 | 使える名前 | このスキルのどの図種で使うか |
| --- | --- | --- |
| UML / 実線矢印 | `block`（塗り三角・既定近い定番）/ `blockThin` / `classic` / `classicThin` / `open`（V 字）/ `openThin` / `halfCircle` / `diamond` / `diamondThin` / `oval` / `circle` / `circlePlus` / `cross` / `box` / `baseDash` / `dash` | `sequence`（`blockThin`）、`class`（`block` / `diamondThin`）、`state`・`screen-flow`（`block`） |
| 二重の矢印の頭 | `doubleBlock`（線を 2 本並べた形の矢印の頭。強調したい方向線に使う） | 手書き XML・`workflow` の強調線 |
| 非同期・往復 | `async`（半円 + 破線風）/ `openAsync` | `workflow`・`aws-arch`（非同期 / イベント線） |
| ER（Crow's Foot） | `ERmandOne` / `ERzeroToOne` / `ERone` / `ERzeroToMany` / `ERmany` / `ERoneToMany` / `manyOptional` | `er`（`references/er.md` の cardinality 対応表） |
| SysML | `sysMLFound` / `sysMLLost` / `sysMLPackCont` / `sysMLProvInt` / `sysMLReqInt` / `sysMLx` | 手書き XML（このスキルのビルダーでは未使用） |

使い分けの実務指針（このスキル内ビルダーで実際に使っている組合せ）:

| 意味 | 書き方 |
| --- | --- |
| 通常の方向（API 呼び出し / 遷移） | `endArrow=block;endFill=1;` |
| 緩い依存・読み取り | `endArrow=open;endFill=0;` |
| 非同期 / 発火だけ | `endArrow=open;dashed=1;` または `endArrow=async;` |
| クラス図の継承 / 実装 | `endArrow=block;endFill=0;`（実装は `dashed=1` を足す） |
| 合成 / 集約 | `startArrow=diamondThin;startFill=1;`（集約は `startFill=0`） |
| ER の基数 | `startArrow=ERmandOne;endArrow=ERmany;` のように両端へ付ける |

---

# 4. ペリメータとエッジスタイル

`mxPerimeter` に **14 種**、`mxEdgeStyle` に **8 種**が登録されている。

| ペリメータ（接続点の取り方） | 用途 |
| --- | --- |
| `RectanglePerimeter` | 角丸カード・長方形。既定 |
| `OrthogonalPerimeter` | 大きいカードで辺に沿った接続点を採る |
| `RhombusPerimeter` | 判断ノード |
| `EllipsePerimeter` / `CenterPerimeter` | 円・疑似状態・アイコン |
| `HexagonPerimeter` / `HexagonPerimeter2` | 6 角形（K8s・六角アイコン） |
| `ParallelogramPerimeter` / `TrapezoidPerimeter` / `StepPerimeter` / `TrianglePerimeter` | フローチャート系 |
| `BackbonePerimeter` / `CalloutPerimeter` / `LifelinePerimeter` | バス・吹き出し・UML ライフライン |

| エッジスタイル | `edgeStyle=` の値 | 用途 |
| --- | --- | --- |
| `OrthConnector` | `orthogonalEdgeStyle` | **既定推奨**。直角配線。このスキルの全ビルダーが使用 |
| `ElbowConnector` | `elbowEdgeStyle` | 1 回だけ折れる配線 |
| `EntityRelation` | `entityRelationEdgeStyle` | ER 図の親子（横に払い出す形） |
| `SegmentConnector` | `segmentEdgeStyle` | 手動ウェイポイントを素直に活かす |
| `Loop` | `loopEdgeStyle` | 自己ループ |
| `IsometricConnector` / `SideToSide` / `TopToBottom` | `isometricEdgeStyle` 他 | アイソメトリック・方位固定 |

ビルダーで実際に使っている直角配線の定型:

```
edgeStyle=orthogonalEdgeStyle;rounded=1;jettySize=auto;html=1;
endArrow=block;endFill=1;strokeColor=#475569;strokeWidth=1.6;
exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0;
```

同じ辺に複数本寄ると線が重なるので、ポート位置を `0.28〜0.72` の間で分散させ、
他ノードを貫く直線には `<Array as="points">` で回避ウェイポイントを入れる
（各ビルダーの `planRelations()` がやっている処理）。

---

# 5. 手書き `.drawio` XML → PNG の recipe

既定ビルダーの spec 形式に載らない図（GCP / K8s / BPMN / ネットワークトポロジなど）は
XML を直接書いて `png` サブコマンドで変換する。これが一番速い。

## 5.1 最小テンプレート

```xml
<mxfile host="skill">
  <diagram id="d1" name="my-diagram">
    <mxGraphModel dx="1000" dy="700" grid="0" gridSize="10" guides="1" tooltips="1"
                  connect="1" arrows="1" fold="1" page="1" pageScale="1"
                  pageWidth="1200" pageHeight="800" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <!-- ノード -->
        <mxCell id="n1" value="API Gateway" vertex="1" parent="1"
                style="rounded=1;html=1;whiteSpace=wrap;fillColor=#1168BD;strokeColor=#0B4E93;fontColor=#FFFFFF;fontSize=13;fontStyle=1;">
          <mxGeometry x="80" y="80" width="200" height="80" as="geometry" />
        </mxCell>
        <mxCell id="n2" value="Order DB" vertex="1" parent="1"
                style="shape=cylinder3;size=12;html=1;whiteSpace=wrap;fillColor=#0E4C8A;strokeColor=#093A6B;fontColor=#FFFFFF;">
          <mxGeometry x="420" y="80" width="160" height="96" as="geometry" />
        </mxCell>
        <!-- 辺 -->
        <mxCell id="e1" value="SQL / TLS" edge="1" parent="1" source="n1" target="n2"
                style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;strokeColor=#1D4ED8;labelBackgroundColor=#FFFFFF;">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

```bash
node scripts/drawio-cli.mjs png my-diagram.drawio -o my-diagram.drawio.png --scale 2 --bg "#FFFFFF"
node scripts/check-layout.mjs my-diagram.drawio        # 重なり検査（0=クリーン / 1=重なり / 2=入力エラー）
```

`--scale 2` が既定。文字が小さければ `--scale 3`。`--embed-xml` は既定 ON なので
出来た `.drawio.png` を draw.io で開くとそのまま再編集できる。

## 5.2 ラベルを書くときの制約（大事）

- `value="..."` の中は **XML エスケープ必須**（`&lt;` `&gt;` `&amp;` `&quot;`）。
- 改行は **`&#10;` で連結**する。`html=1;whiteSpace=wrap;` と併用すると複数行で描ける。
  属性値に生の `<br/>` を入れると XML が壊れて変換が落ちる。
- 太字 / イタリック / 色は HTML 断片を **1 回だけ** エスケープして書く:
  `value="&lt;b&gt;注記&lt;/b&gt;&#10;2 行目"`（`html=1` が前提）。
- 日本語混じりの文字幅はエンジン側が CJK を 1.0 em、半角を 0.3〜0.88 em で測る。
  カード幅を手で決めるなら「全角 = フォントサイズ × 1 文字分」で見積もると正確。
- 辺ラベルは白背景を付ける: `labelBackgroundColor=#FFFFFF;`

## 5.3 図法別スタイル断片

**GCP**（`gcp2` は 297 種。青基調に統一するのが draw.io 流）

```
shape=mxgraph.gcp2.doubleRect;fillColor=#4285F4;strokeColor=none;fontColor=#1A73E8;
verticalLabelPosition=bottom;verticalAlign=top;html=1;
```

**Kubernetes**（`kubernetes` 79 種。`icon` は汎用ヘックス、`pod` / `deploy` 等が個別アイコン）

```
shape=mxgraph.kubernetes.pod;fillColor=#326CE5;strokeColor=none;
verticalLabelPosition=bottom;html=1;
```

**BPMN**（イベント = 円、タスク = 角丸、ゲートウェイ = ひし形）

```
イベント: shape=mxgraph.bpmn.shape;perimeter=ellipsePerimeter;outline=general;symbol=general;
タスク  : shape=mxgraph.bpmn.shape;rounded=1;outline=standard;symbol=task;
Userタスク: shape=mxgraph.bpmn.shape;rounded=1;outline=standard;symbol=user;
ゲートウェイ: shape=mxgraph.bpmn.shape;perimeter=rhombusPerimeter;outline=standard;symbol=exclusive;
シーケンス矢印: edgeStyle=orthogonalEdgeStyle;endArrow=blockThin;endFill=1;dashed=1;
```

**ネットワークトポロジ**（`cisco19` 232 種 / `networks2` 115 種 / `cisco_safe` 485 種）

```
機器  : shape=mxgraph.cisco19.router;fillColor=#036C96;strokeColor=none;
LAN バス: shape=mxgraph.networks.bus;fillColor=#FFFFFF;strokeColor=#64748B;
クラウド : shape=cloud;fillColor=#F1F5F9;strokeColor=#64748B;
リンク : endArrow=none;startArrow=none;strokeColor=#64748B;
```

**AWS**（Terraform ではなく手で書くとき）

```
resourceIcon: shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda;
              fillColor=#ED7100;strokeColor=none;verticalLabelPosition=bottom;html=1;
グループ枠  : shape=mxgraph.aws4.group;fillColor=none;strokeColor=#879196;dashed=1;
```

---

# 6. よくある失敗と対処

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| `XML が壊れています（</mxCell> に対応する開始タグがありません）` | 属性値に生 `<br/>` / 未エスケープの `<` | `&#10;` に置換し、`&` を先に `&amp;` へ |
| アイコンが白い四角 / 何も見えない | ステンシルの `fillColor` 未指定、または外部画像参照 | `fillColor` / `strokeColor` を明示、画像は base64 埋め込み |
| 文字がカードからはみ出す | 全角幅を見越していない | 全角 = 1.0 em で再計算、または `whiteSpace=wrap;` + 幅を広げる |
| 線がラベルに重なる | ラベルが線の中点固定 | `labelBackgroundColor=#FFFFFF` + 側方オフセット、または `relative` 位置をずらす |
| グループ枠とラベルが「重なり」扱いになる | 検査器は枠もノードとして数える | 枠内のラベルは許容。`--json` の `problems` を見て実害だけ直す |
|PNG が極端に縦長 | spec の折り返し幅指定を誤って 1 文字折返しになっている | spec の `tech` / `description` を短縮、ビルダーの折返し幅を確認 |

---
