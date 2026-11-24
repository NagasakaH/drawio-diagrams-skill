> 統合スキル `drawio-diagrams-skill` のうち **UML シーケンス図** を担当するリファレンス。
> 実行はすべて `node scripts/drawio-cli.mjs sequence ...` / `node scripts/drawio-cli.mjs png ...` 経由。

# UML シーケンス図生成スキル (`drawio-sequence`)

JSON スペックを `scripts/build-sequence.mjs` に渡すと、ヘッダ・凡例・参加者ヘッダ/フッタ・
破線ライフライン・アクティベーションバー・UML 断片 (alt / opt / loop / par)・クリーム色のノートを
備えた `.drawio` XML と `.drawio.png`（元XML埋め込み済み・draw.io再編集可能）を 1 コマンドで生成する。
変換は同梱の `scripts/drawio2png.mjs`（Pure Node.js・ゼロ依存）が行い、`npm install` は不要。

---

## 実行手順

### 1. JSON スペックを作る

参加者（`participants`）と時系列メッセージ（`messages`）を列挙した JSON を作成する。
`kind`（actor / client / service / database / queue / external）、`type`
（sync / async / reply / return）、`activate: true`、`autonumber: true` が主要な指定子。
断片・ノート・明示アクティベーションの詳細は 本ドキュメント末尾のスペック仕様 を参照。
お手本は `examples/sequence/order-checkout.json`（EC 注文・決済フロー、alt/opt/par 全て使用）。

### 2. `.drawio` + `.drawio.png` を一括生成

```bash
node scripts/drawio-cli.mjs sequence \
  --spec /path/to/sequence.json \
  --output /path/to/sequence.drawio.png
# → /path/to/sequence.drawio (XML) と sequence.drawio.png が同時に出力される
```

SVG 出力・タイトル上書き・縮尺などのオプション:

```bash
node scripts/drawio-cli.mjs sequence --spec seq.json -o seq.svg
node scripts/drawio-cli.mjs sequence --spec seq.json -o seq.drawio.png \
  --title "注文フロー" --subtitle "v2 改訂版" --scale 2 --border 16
```

### 3. 目視検証（必須）

生成された `.drawio.png` を `read_image` で読み込み、以下を確認してからユーザーへ報告する。

- ラベル同士の重なり（長いラベル同士が当たる場合は `gap` や `spacing` で調整）
- フラグメント枠 `[条件]` テキストと直後メッセージラベルの間隔
- ノートが次の行やフラグメント枠に被っていないか（`height` / `dy` / 直前 `gap` で調整）

### 4. 再編集・再変換

- `.drawio.png` は XML 埋め込み済みなので draw.io で直接開いて再編集できる。
- 手編集後の図面は `node scripts/drawio-cli.mjs png <図.drawio|図.drawio.png> -o <out.png>` で再変換、
  `--extract-xml` で PNG から XML を取り出せる。

---

## リファレンス

- 本ドキュメント末尾のスペック仕様 — JSON スペック全キー仕様・kind 別配色・レイアウト調整のヒント

---

# シーケンス図 JSON スペックリファレンス (`build-sequence.mjs`)

`build-sequence.mjs` に `--spec` で渡す JSON の完全な仕様です。
トップレベルの必須キーは `participants` と `messages` だけで、ほかはすべて省略可能です。

```jsonc
{
  "title": "EC 注文・決済フロー",          // 図タイトル（左上・18px ボールド）
  "subtitle": "決済承認までの時系列",       // サブタイトル（11px グレー）
  "autonumber": true,                      // true で全メッセージに "1. 2. 3." を自動付番
  "spacing": 220,                          // 隣接ライフライン間隔 px（既定 220、推奨 210–230）
  "rowHeight": 46,                         // メッセージ 1 行のピッチ px（既定 46）
  "legend": true,                          // 右上凡例ボックス（既定表示、false で非表示）

  "participants": [ ... ],                 // 参加者（左 → 右順）
  "messages":     [ ... ],                 // メッセージ（時系列順）
  "activations":  [ ... ],                 // 明示的な有効期間（アクティベーション）
  "fragments":    [ ... ],                 // alt / opt / loop / par 断片
  "notes":        [ ... ]                  // クリーム色の注釈ボックス
}
```

---

## participants（参加者）

| キー | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` | string | ✓ | メッセージ・フラグメント・ノートから参照する ID |
| `name` | string |  | ヘッダボックスの表示名（省略時 `id`） |
| `sub` | string |  | 2 行目の補足（9px グレー。例: `Aurora PostgreSQL`） |
| `kind` | string |  | `actor` / `client` / `service` / `database` / `queue` / `external`（既定 `service`） |

`kind` 別の配色（塗色 / 枠色）:

| kind | 塗色 | 枠色 | 用途の例 |
|---|---|---|---|
| `actor` | `#EFF6FF` | `#2563EB` | ユーザー、外部アクター |
| `client` | `#F0FDF4` | `#16A34A` | Web UI・スマホアプリ |
| `service` | `#F8FAFC` | `#0F172A` | API サーバー・マイクロサービス |
| `database` | `#EEF2FF` | `#4F46E5` | RDS / Aurora / DynamoDB |
| `queue` | `#FDF2F8` | `#DB2777` | SQS / Kafka / Notification Queue |
| `external` | `#FFFBEB` | `#D97706` | 外部 SaaS・決済ゲートウェイ |

ヘッダボックスは図の上部と下部の両方に同じ内容でミラー描画され、
間を破線（`#94A3B8`, dashPattern `5 4`）のライフラインが結します。

---

## messages（メッセージ）

| キー | 型 | 必須 | 説明 |
|---|---|---|---|
| `from` | string | ✓ | 送信側 participant id |
| `to` | string | ✓ | 受信側 participant id（`from` と同じなら自己メッセージ） |
| `label` | string |  | 矢印ラベル（白背景・10.5px） |
| `type` | string |  | `sync`（既定）/ `async` / `reply` / `return` |
| `activate` | boolean |  | `true` で受信側にアクティベーション開始 |
| `gap` | number |  | この行の後に追加で空ける縦間隔 px（ノート・フラグメント避け用） |

矢印スタイル:

| type | 形状 |
|---|---|
| `sync` | 黒 (`#1E293B`, 1.5px) の実線 + 塗りつぶし三角 |
| `async` | 青 (`#0284C7`, 1.6px) の破線 (`6 3`) + 開いた矢印 |
| `reply` / `return` | グレー (`#64748B`, 1.4px) の破線 (`5 3`) + 開いた矢印 |

**自己メッセージ**（`from === to`）はライフラインの右側に幅 38px・高さ 20px の
折り返しループとして描かれ、ラベルはループの右側に配置されます。

**`activate: true` の自動終了**: `from → to` の `sync`/`async` メッセージで
`to` にアクティベーションを開始し、以降初めの「`to` から `from` への `reply`/`return`」
までbarsを伸ばします。対応する reply が無い場合は図の末尾まで伸ばします。

---

## activations（明示的な有効期間）

`activate: true` の自動検出では足りない場合（返信が別経路に戻る、同一ライフライン内で
複数バーを積みたい等）に明示指定します。ステップ番号は **1 オリジン**（messages の何番目か）。

```jsonc
"activations": [
  { "participant": "db", "fromStep": 3, "toStep": 4 }
]
```

バーは幅 12px・白塗りに `#475569` の枠（1.2px）です。

---

## fragments（UML 断片: alt / opt / loop / par）

```jsonc
"fragments": [
  {
    "type": "alt",                 // alt | opt | loop | par | break | critical
    "label": "決済応答",            // 条件テキスト → 左上に [決済応答] と表示
    "fromStep": 5,                 // 含める最初のメッセージ（1 オリジン）
    "toStep": 7,                   // 含める最後のメッセージ（1 オリジン）
    "fromParticipant": "api",      // 横幅の左端ライフライン（省略時: 先頭参加者）
    "toParticipant": "pay",        // 横幅の右端ライフライン（省略時: 末尾参加者）
    "elseAtStep": 7,               // alt のみ: else 分岐の開始ステップ
    "elseLabel": "else [402 決済拒否]"  // else 区切り線の上のラベル
  }
]
```

- 枠は **背景レイヤー**（矢印・ラベルより先に XML 出力）なので矢印を隠しません。
- 破線 (`6 4`) の枠 + 極薄の塗色（alt `#F8FAFC` / opt `#F0FDF4` / loop `#FFFBEB` / par `#EEF2FF`）。
- 左上隅に UML タグバッジ（`alt` 等のボールド小箱）、その右に `[条件]` テキスト（白背景）。
- `elseAtStep` を指定すると alt 枠内に破線の区切り線を引き、`elseLabel` を添えます。

---

## notes（注釈）

```jsonc
"notes": [
  // ライフラインの右（末尾参加者は左）に置く場合
  { "atStep": 5, "participant": "pay", "text": "3D セキュア対応 / 10s タイムアウト",
    "width": 176, "height": 44, "dy": 14 },

  // 2 つのライフラインの間にまたがせる場合
  { "atStep": 2, "participant": "web", "spanTo": "api",
    "text": "PCI DSS 準拠: 送信はトークン化済み payment_token のみ", "height": 40 }
]
```

| キー | 既定 | 説明 |
|---|---|---|
| `atStep` | 1 | 基準行（1 オリジン）。`y = 該当行 + dy` |
| `participant` | 先頭参加者 | 基準ライフライン id |
| `spanTo` | — | 指定すると `participant`〜`spanTo` の間にまたがる横幅になる |
| `dy` | 14 | 基準行からの縦オフセット px |
| `width` / `height` | 172 / 40 | `spanTo` 使用時は幅自動計算 |

塗色 `#FFFBEB`・枠 `#F59E0B`・文字 9.5px `#92400E` の角丸ボックス。最前面に描画されます。

---

## レイアウトの決まりごと（調整のヒント）

- `spacing` を詰める（210 未満）と長いラベル同士が当たりやすくなります。
- フラグメント枠は該当行の上下（上 40px / 下 22px）に余白を取って広がります。
  自己メッセージ（下方向に 20px + ラベル）の直後にフラグメントを始めるときは、
  自己メッセージ側の `gap: 30` 程度で間隔を空けるときれいに収まります。
- ノートは行の「下」に置くため、直後の行がフラグメント開始行だと重なることがあります。
  同様に直前メッセージへ `gap` を入れてください。

---

