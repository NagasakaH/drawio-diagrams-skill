---
name: drawio-diagrams
description: >-
  スイムレーン業務フロー図、Terraform (.tf) 解析による AWS アーキテクチャ構成図、
  UML シーケンス図、UML クラス図（TypeScript / JavaScript ソーススキャン）、
  Crow's Foot 記法の ER 図（SQL DDL / Prisma スキーマスキャン）、UML 状態遷移図、
  C4 Container レベルの構成図、画面遷移図（スクリーンフロウ）の 8 種類の draw.io 図面を、
  ゼロ依存 Node.js (.mjs) で .drawio XML と XML 埋め込み済み .drawio.png（draw.io 再編集可能）として生成する統合スキル。
  npm install も draw.io アプリもブラウザ不要。JSON spec またはソース／スキーマ走査の 1 コマンド生成で、
  生成 PNG は画像として貼れるほか draw.io で開いて再編集できる。手書き .drawio XML を PNG / SVG にする
  汎用変換と、埋め込みステンシル（AWS / GCP / Kubernetes / BPMN / Cisco など 4,000 種超）の一覧も備える。
  「業務フロー・スイムレーンで図にして」「Terraform から AWS 構成図」「シーケンス図を作って」
  「TS/JS ソースからクラス図」「DDL / Prisma から ER 図」「ステータスの状態遷移図を作って」
  「C4 のコンテナ図でシステム構成」「画面遷移図を draw.io で」「draw.io で PNG を作りたい」
  「このプロジェクトの設計図を一式作って」といった依頼のときに使用する。
---

# drawio-diagrams — 8 種の draw.io 図面 統合ルーター

1 本の共通エンジン `scripts/drawio2png.mjs` と統合 CLI `scripts/drawio-cli.mjs` で、
8 種類の図を `.drawio` + `.drawio.png`（XML 埋め込み済み）として生成する。
詳細は図ごとに `references/<type>.md` へ段階的に開示する。**依頼を受けた図種の reference だけを読む**こと。

## 1. 図種別ルーティング表

| ユーザーの依頼 | 最初に読む | 実行コマンド | 必須の確認事項 / デフォルト方針 |
|---|---|---|---|
| 業務フロー・スイムレーン（画面→バックエンド→ストレージの連動） | [references/workflow.md](references/workflow.md) | `node scripts/drawio-cli.mjs workflow --spec <flow.json> --direction horizontal\|vertical --output <out.drawio.png>` | **spec 作成前にレーン構成と縦/横方向をユーザーに必ず確認**（prompt で明示済みの場合は省略） |
| AWS 構成図（Terraform がある） | [references/aws-arch.md](references/aws-arch.md) | `node scripts/drawio-cli.mjs aws-arch --tf-dir <dir> --output <out.drawio.png>` | SG / IAM / VPC / CloudWatch は**デフォルト省略**。ユーザーが明示したら `--include security,network,iam,observability` を付ける |
| シーケンス図（API・DB・外部連携の時系列） | [references/sequence.md](references/sequence.md) | `node scripts/drawio-cli.mjs sequence --spec <seq.json> --output <out.drawio.png>` | 参加者 kind（actor/client/service/database/queue/external）と alt/loop 等の分岐有無を spec に反映 |
| クラス図（ドメインモデル / TS・JS ソース） | [references/class.md](references/class.md) | `node scripts/drawio-cli.mjs class --spec <spec.json> --output <out.drawio.png>`（ソースからは `--src-dir <src>` でも可） | stereotype・パッケージ区分・描画範囲（モジュール全体か一部か）を確認 |
| ER 図（SQL DDL / Prisma） | [references/er.md](references/er.md) | `node scripts/drawio-cli.mjs er --schema <file.sql\|dir> --output <out.drawio.png> --json-out <er.json>` | スキャン後は必ず JSON を確認し、誤検知（enum・複合 FK）や cardinality を補正してから描画 |
| 状態遷移図（オーダステータス等のライフサイクル） | [references/state.md](references/state.md) | `node scripts/drawio-cli.mjs state --spec <state.json> --output <out.drawio.png>` | 初期 / 終了状態、ガード付き遷移、複合状態（サブステート）の有無を spec に反映 |
| C4 Container 図（境界 + 実行単位 + プロトコル） | [references/c4.md](references/c4.md) | `node scripts/drawio-cli.mjs c4 --spec <c4.json> --output <out.drawio.png>` | 人（アクター）・自社境界・外部 SaaS を分け、各関係に `HTTPS / JSON` 等のプロトコルを必ず書く |
| 画面遷移図（Web / アプリの導線） | [references/screen-flow.md](references/screen-flow.md) | `node scripts/drawio-cli.mjs screen-flow --spec <flow.json> --output <out.drawio.png>` | ルート、モーダル / エラー / 外部離脱、アクセス権区分（Public / Authenticated 等）を spec に反映 |
| 既存 `.drawio` の PNG / SVG 化・再変換、手書き XML の図化 | [references/catalog-and-stencils.md](references/catalog-and-stencils.md) | `node scripts/drawio-cli.mjs png <in.drawio> -o <out.drawio.png> --scale 2 --embed-xml` | `--embed-xml` で元 XML を埋め込み、`--extract-xml` で PNG から XML を取り出せる。シンボル在庫と XML テンプレは catalog 側 |

### 「画面 → API → DB」のように依頼が曖昧なときの振り分け

同じ「画面から DB に到達する流れ」でも、見せたい軸で図種が変わる。迷ったら次で決める。

| 依頼の意図 | 図種 | 判断材料 |
|---|---|---|
| リクエスト処理の**時間順**（呼び出しと戻り、交互に走るライフライン） | `sequence` | 「呼び出し順」「タイムライン」「リクエスト／レスポンス」 |
| 画面・API・DB が**所有者をまたいでどう連動するか**（誰が何をしたか） | `workflow` | 「レーン」「役割ごとに」「業務として成立する流れ」 |
| 画面から画面への**導線**（遷移・分岐・エラー画面） | `screen-flow` | 「画面遷移」「導線」「ナビゲーション」 |

補助スクリプト: 配置検査 `node scripts/check-layout.mjs <図.drawio>`（終了コード 0=指摘なし / 1=重なり候補 / 2=入力エラー）、
スキャナ単体実行 `node scripts/scan-terraform.mjs` / `scan-classes.mjs` / `scan-schema.mjs`。
シンボル・ステンシル・矢印マーカーの在庫は [references/catalog-and-stencils.md](references/catalog-and-stencils.md)。

## 2. ルール

1. 依頼を受けてから**最初に上表で図種別を決め、該当する `references/<type>.md` を必ず読んでから** spec を作り、コマンドを実行する。
2. **無関係な図種の reference は読まない**（コンテキストを浪費するため）。1 回の依頼で複数図を作る場合も、使う図種だけを順に読む。
3. workflow は step 0 のユーザー確認（方向・レーン構成）を飛ばさない。確認は推奨案を提示して一度に行う。
4. spec ファイルはワークスペース内に保存する（`.drawio.png` は XML 埋め込み済みだが、再生成・微調整は spec から行う）。
5. **ユーザープロジェクトのディレクトリでカレントディレクトリを動かさない**。スキルフォルダへ `cd` せず、
   スクリプトはスキルフォルダの絶対パスで呼ぶ: `node <skill-dir>/scripts/drawio-cli.mjs ...`
   （`<skill-dir>` はこの SKILL.md を置くディレクトリ）。spec・出力・`--schema` などの入出力パスは
   ユーザープロジェクトからの相対パスで指定する。ドキュメントや reference 内に `scripts/...`、
   `examples/...`、`references/...` と書かれたパスはスキルフォルダからの相対パスなので、
   実行時は `<skill-dir>/scripts/...` のように解決する（`npm run demo` はスキルフォルダ内の
   メンテナ用コマンドであり、ユーザープロジェクトでの実行手順ではない）。
   外部 npm パッケージは不要（ゼロ依存、Node 標準ライブラリと同梱の `<skill-dir>/scripts/drawio2png.mjs` のみで動く）。

## 3. 一括生成モード（「設計図を一式作って」）

「このプロジェクトの設計図を一式」「設計書用図面をまとめて」と頼まれたときは次を行う。

1. ワークスペースを走査し、材料となるファイルを発見する:
   - `**/*.tf` → aws-arch、`**/*.sql` / `**/*.prisma` → er、`src/**/*.ts` / `**/*.js` → class
   - ルーティング定義・画面コンポーネント → screen-flow、ステータス列挙・状態遷移コード → state、
     マニフェスト / docker-compose / README → c4
   - 業務フローはソースから自動生成できないので、コード・README から主要フローを整理し、レーン構成案をユーザーに確認する
2. 見つかった図種について、`references/<type>.md` を 1 種ずつ順に読み、上表のコマンドで生成する（1 図種終わるごとに次の reference を読む）。
3. 出力はまとめて 1 ディレクトリ（例 `docs/diagrams/` または `examples/output/`）へ置き、ファイル名を図種で判別できるようにする（`*-arch.drawio.png`、`*-er.drawio.png` など）。
4. 該当ファイルが無い図種は作らない。全部で 2 図種以上になるときは生成計画を先に提示してもよい。
5. `sequence` は材料を自動発見できない図種である点に注意する。`**/*.tf` や `src/**` があってもシーケンス図は**作らない**。
   作ってよいのは、呼び出し順を示す材料（README の処理説明・ハンドラの呼び出し関係・API クライアントコードなど）を
   基に人が spec の消息列を合意して起こせる場合だけだ。消息を書けないなら他の 7 図種だけを生成する。

## 4. 共通の出力規約

- 出力は `.drawio`（XML）と `.drawio.png`（元 XML 埋め込み済み）のペアで生成される。
  `--output xxx.png` から `xxx.drawio` のパスは自動決定されるが、`--xml-out` で明示もできる。
- `.drawio.png` はそのまま画像としてチャット・ドキュメントに貼れる。ユーザーが再編集する場合は
  draw.io アプリで PNG を開くか、`node scripts/drawio-cli.mjs png input.drawio.png --extract-xml -o output.drawio` で XML を取り出す
  （`--extract-xml` はフラグで、出力先は `-o` で指定する）。
- PNG 解像度は `--scale`（既定 2）、余白は `--border`（既定 16）。図タイトルは `--title` / `--subtitle` で上書き。
- 手編集した `.drawio` は `node scripts/drawio-cli.mjs png <in.drawio> -o <out.drawio.png> --embed-xml` で再変換する。
- aws-arch / class / er は「スキャン → JSON 保存 → 補正 → 再描画」の 2 段階を推奨する
  （`--json-out` / `scan-*.mjs -o` で得た JSON を直してから `--spec` で描く）。ER の典型例:

  ```bash
  # 1. スキャンして JSON をユーザープロジェクト内に保存（この時点の cardinality は推定。
  #    /tmp ではなく図と同じ docs/diagrams/ に置くと、後の再編集・再生成が同じ spec からできる）
  node <skill-dir>/scripts/drawio-cli.mjs er --schema db/schema.sql \
    --json-out docs/diagrams/er.json --output docs/diagrams/er-preview.drawio.png
  # 2. docs/diagrams/er.json を開いて確認・補正する（誤検知 FK の削除、
  #    `relations[].cardinality` を 7 値のいずれかへ修正、displayName / 配置 row,col の追記）。
  #    補正内容をユーザーに確認してもらってから次の描画に進む
  # 3. 補正済み JSON から正確なパスで描き直す（中間物を他所へ散らさない）
  node <skill-dir>/scripts/drawio-cli.mjs er --spec docs/diagrams/er.json \
    --output docs/diagrams/er.drawio.png
  ```

## 5. 出力品質チェック（必須）

1. 生成後、まず機械検査: `node scripts/check-layout.mjs <図.drawio>` で重ね合わせを指摘する。
   指摘は**配置改善のヒント**であり、破線枠（境界・パッケージ・alt 断片・グループ）の辺をまたぐラベルなど、
   図として意図的で読みやすいcaseも 1 を返すことがある。出口は必ず生成 PNG を目視して決める。
2. 次に**必ず `.drawio.png` を画像として読み込み目視確認**する: 文字切れ・ラベルと線の重なり・枠外のはみ出し・アイコン重なり・凡例の欠落をチェックする。
3. 崩れがあれば spec の配置・余白・ラベル幅系オプション（各 reference の調整ヒント）を直して再生成し、直ったことを確認してからユーザーに提示する。
4. 目視で直せなかった場合でも、検査結果と残る課題を正直に添えて提示する。「生成できた」だけで完了を宣言しない。

## 6. スクリプト配置

```text
scripts/
├── drawio-cli.mjs        # 統合 CLI ディスパッチャ（--help で一覧。shape 名検索 `shapes` を含む）
├── drawio2png.mjs        # 共通コンバーター（全ビルダーが共有する単一ファイル）
├── check-layout.mjs      # 配置・重なり検査
├── build-workflow.mjs    # スイムレーン業務フロー図
├── build-aws-arch.mjs    # + scan-terraform.mjs（Terraform → AWS 構成図）
├── build-sequence.mjs    # UML シーケンス図
├── build-class.mjs       # + scan-classes.mjs（UML クラス図 / TS・JS）
├── build-er.mjs          # + scan-schema.mjs（Crow's Foot ER 図 / SQL・Prisma）
├── build-state.mjs       # UML 状態遷移図
├── build-c4.mjs          # C4 Container 図
├── build-screen-flow.mjs # 画面遷移図
└── diagram-shared.mjs    # 共通：XML エスケープ / セル ID 採番 / 直接実行判定
```

サブコマンドは引数をそのまま対応ビルダーへ転送するだけなので、各ビルダーの `--help` と
オプション体系はそのまま有効である。
