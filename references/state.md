> 統合スキル `drawio-diagrams-skill` のうち **UML 状態遷移図** を担当するリファレンス。
> 実行はすべて `node scripts/drawio-cli.mjs state ...` 経由。

# UML 状態遷移図生成スキル (`drawio-state`)

JSON spec を描画して `.drawio` XML および `.drawio.png`（元XML埋め込み済み・draw.io再編集可能）を
生成する。Pure Node.js (.mjs) のみで動作し、外部 npm 依存はゼロ。
オーダステータス・予約枠・キャンペーンなど「ライフサイクルを持つオブジェクトの遷移」を
`event [guard] / action` ラベル付きの矢印で表現する。

---

## デフォルトの描画方針

- **レイアウト**: spec の `row` / `col` を優先（0 始まり整数）。未指定は各行末尾へ自動追加。
  水平間隔 176px・垂直間隔 138px を基準に、カード実測幅で列幅・行高を決める。
- **状態カード**: `名前`（13px 太字）+ `entry / do / exit` アクション行（10.5px）。
  `semantic` の意味色で塗る（下表）。幅は内容から自動（148〜300px）。
- **疑似状態**: 開始は塗り潰し円（`●`）、終了は二重円（`◎` + 内側ドット）。名前は補助テキストで出す。
- **複合状態**: `groups[]` を薄紫の破線枠で描き、左上に `複合状態 · ラベル`。
  メンバーは `states[].group` からも暗黙に枠を作る。
- **遷移線**: orthogonal 配線。同一辺に複数本寄る場合はポート位置を 0.28〜0.72 へ分散。
  行を左戻る遷移・他カードを貫く遷移は自動で回避ウェイポイントを投入する。
  自己ループ（`from === to`）はカード右側に回す。
- **ラベル**: `event [guard] / action` を自動合成し、`labelBackgroundColor=#FFFFFF` 付きで
  線の実側（縦線は左／横線は上）へ寄せる。折り返しは renderer の文字幅推定で計算する。
- **エラー・キャンセル**: `kind: "error"` / `"cancel"` は赤破線、`"retry"` は琥珀破線。
- **ヘッダー**: 左端アクセントバー (#7C3AED) + 左寄せタイトル / サブタイトル + 細区切り線、
  右上に凡例（正常遷移・エラー / キャンセル・初期状態・終了状態・複合状態）。

---

## 実行手順

### 1. JSON spec から直接描画（最短1コマンド）

```bash
node scripts/drawio-cli.mjs state \
  --spec /path/to/state-spec.json \
  --output /path/to/state-diagram.drawio.png
```

`--output` から `.drawio` XML のパスを自動決定する（`xxx.drawio.png` → `xxx.drawio`）。
明示指定は `--xml-out`、タイトル上書きは `--title` / `--subtitle`、PNG解像度は `--scale`（既定 2）。
`--no-png` で XML のみ生成も可。`.svg` 出力は出力拡張子で自動判定。

### 2. 配置の調整

`row` / `col` は「移動の方向」が左→右・上→下になるよう振るのが読みやすさのコツ。
同一 `col` に並べると縦の系列（例: `PAID → SHIPPED → DELIVERED`）が真っ直ぐにつながる。
往復遷移が多い場合は `row` を分けて上下に離すと線が交差しない。

### 3. 目視検証（必須）

生成された `.drawio.png` を画像読み込みで確認し、ラベルの欠落・線とカードの重なりを
チェックしてからユーザーへ報告する。`node scripts/check-layout.mjs <生成 .drawio>` で
機械検査もできる（終了コード 0 = クリーン、1 = 重なりあり）。

---

## リファレンス

- 本ドキュメント末尾のスペック仕様 — JSON spec の全フィールドと遷移タイプ一覧

---

# JSON spec リファレンス (`drawio-state`)

`build-state.mjs --spec` に渡す JSON の形式。最上位キーは `title` / `subtitle` / `groups` /
`states` / `transitions`。必須は `states` のみ（空配列はエラー）。

```json
{
  "title": "注文ライフサイクル（状態遷移図）",
  "subtitle": "1行の補足説明（任意）",
  "groups": [
    { "id": "fulfillment", "label": "出荷パイプライン" }
  ],
  "states": [ ... ],
  "transitions": [ ... ]
}
```

## `states[]` — 状態ノード

| フィールド | 必須 | 説明 |
| --- | --- | --- |
| `id` | ○* | 図内一意の参照キー（`transitions` から参照）。*`name` だけで書くことも可 |
| `name` | ○ | カード見出しの状態名。日本語可 |
| `kind` | | `state`（既定）/ `initial`（`start` も可）/ `final`（`end` `terminate` も可） |
| `semantic` | | 意味色。下表参照。既定 `normal` |
| `group` | | 所属する複合状態の `id`。`groups[]` に無い id なら暗黙に枠を追加 |
| `row` / `col` | | グリッド配置（0 始まりの整数）。未指定は自動 |
| `entry` | | `entry / <テキスト>` の 1 行として表示 |
| `do` | | `do / <テキスト>`（継続中の処理） |
| `exit` | | `exit / <テキスト>` |
| `actions` | | 上記のあとに続く任意行数のアクション行（文字列配列） |

- `initial` / `final` は円形ノードになり、`name` は空にすると図がすっきりする。
- アクション行は折り返しまるごと自動採寸される（最大幅 300px）。

### semantic パレット

| 値 | 塗 / 枠 | 使われ方 |
| --- | --- | --- |
| `normal` | `#EEF2FF` / `#4F46E5` | 通常の滞在中状態 |
| `active` | `#DBEAFE` / `#2563EB` | 処理が走っている状態 |
| `success` | `#ECFDF5` / `#059669` | 正常完了系 |
| `warning` | `#FFFBEB` / `#D97706` | 要対応・保留 |
| `error` | `#FEF2F2` / `#DC2626` | 失敗・異常 |
| `neutral` | `#F8FAFC` / `#64748B` | 補助・ダミー |

## `transitions[]` — 遷移矢印

| フィールド | 必須 | 説明 |
| --- | --- | --- |
| `from` | ○ | 開始状態の `id`（疑似状態も指定可） |
| `to` | ○ | 遷移先状態の `id` |
| `event` | | 発生イベント名（`PAY` など） |
| `guard` | | 条件。`event` と合わせ `PAY [在庫あり]` の形にする |
| `action` | | 遷移時に走る処理。`/ notify_shipment` のように `/` 付きで描く |
| `label` | | 指定すると `event` / `guard` / `action` の合成を無視してそのまま表示 |
| `kind` | | 下表参照。既定 `normal` |

### 遷移 kinds

| `kind` | 描画 |
| --- | --- |
| `normal` | 実線 + 塗り三角（グレー `#475569`） |
| `success` | 実線 + 塗り三角（緑 `#059669`） |
| `error` | 赤破線 + 塗り三角 |
| `cancel` | 赤破線 + 塗り三角（error と同じ描画、意味づけ用） |
| `retry` | 琥珀破線 + 塗り三角（同じ状態への再試行ループ向き） |

- `from === to` の自己遷移はカード右側のループになり、ラベルはループの外側に出る。
- 同じ状態ペアの往復（A→B / B→A）は自動的に上下（左右）へラベルを分ける。

## `groups[]` — 複合状態の破線枠（任意）

| フィールド | 必須 | 説明 |
| --- | --- | --- |
| `id` | ○ | `states[].group` から参照される id |
| `label` | | 枠左上 `複合状態 · <label>` に表示（既定は `id`） |

枠はメンバー状態の外接矩形を内包するよう自動計算される。

---
