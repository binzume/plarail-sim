# レール部品データ仕様 v1

## 1. 基本方針

レール部品は、**論理的な接続情報と列車走行に必要な経路情報**だけを JSON で定義する。

- 部品の表示画像・3Dモデル等は別 DB で `part.id` をキーとして管理する。
- 部品定義はローカル座標系で記述する。
- レイアウト上のレールは、部品定義に対して位置・回転・左右反転を適用したインスタンスとして表現する。
- レール同士の接続は、コネクタ間の接続として明示的に管理する。
- コネクタの位置は `[x, y, z]`。
- コネクタの向きは水平面内の角度 `direction` で表現する。
- `z` は高さを表す。
- コネクタ自体が傾斜することは v1 では想定しない。

---

## 2. 部品定義

```json
{
  "schemaVersion": 1,
  "type": "rail",
  "id": "switch",
  "flippable": true,

  "connectors": [
    {
      "position": [0, 0, 0],
      "direction": 180,
      "end": "male"
    },
    {
      "position": [315, 100, 0],
      "direction": 30,
      "end": "female"
    },
    {
      "position": [315, -100, 0],
      "direction": -30,
      "end": "female"
    }
  ],

  "paths": [
    {
      "from": 0,
      "to": 1,
      "shape": "straight"
    },
    {
      "from": 0,
      "to": 2,
      "shape": "curve"
    }
  ],

  "switches": [
    {
      "id": "point",
      "states": {
        "straight": 0,
        "branch": 1
      },
      "default": "straight"
    }
  ]
}
```

### `schemaVersion`

JSON スキーマのバージョン。

現在は `1`。

### `id`

部品を一意に識別する ID。

表示モデル・画像などを取得するときのキーとしても使用する。

### `type`

部品の種別。現在はレールの `rail`、列車の `train`、コメントの `text` を使用する。

将来、建物や情景部品などを追加する場合は、種別ごとに値を定義する。

### `name`

画面などで表示する部品名を言語別に定義する。

```json
"name": {
  "ja": "直線"
}
```

エディタでは `name.ja` を表示名として使用する。

### `flippable`

部品を左右反転可能か。

```json
"flippable": true
```

`false` の場合、その部品インスタンスでは `flip: true` を指定してはならない。

---

# 3. 座標系

部品内部では右手系等の3D座標系を厳密に定義する必要はなく、v1では以下とする。

- `x`：左右方向
- `y`：前後方向
- `z`：高さ
- `[0, 0, 0]`：部品の基準位置

通常の2D表示では `x,y` を使用し、`z` は高さとして扱う。

---

# 4. コネクタ

```json
{
  "position": [315, 0, 0],
  "direction": 0,
  "end": "female"
}
```

## `position`

部品ローカル座標での接続位置。

単位はプロジェクト全体で統一する。  
例として mm を使用する。

```text
[x, y, z]
```

## `direction`

コネクタから**レールの外側へ向かう方向**を角度で表す。

- `0°` = +X（右）
- `90°` = +Y（上）
- `180°` = -X（左）
- `270°` = -Y（下）
- 負の角度も使用可能
- 実装時には必要に応じて `0～360°` に正規化する

例えば、左端から右方向へ伸びるレールでは、

```json
"direction": 180
```

となる。

これは「レールが左を向いている」という意味ではなく、**接続相手が存在する方向**を表す。

## `end`

物理的なレール端の種類。

v1では以下を使用する。

```text
male
female
```

接続可能性はエンジン側で判定する。

例えば、

```text
male ↔ female
```

を接続可能とする。

部品 JSON に接続ルールそのものは記述しない。

---

# 5. コネクタの識別

コネクタは名前ではなく**配列インデックス**で識別する。

```json
"connectors": [
  { ... },
  { ... },
  { ... }
]
```

この場合、

```text
0 = connectors[0]
1 = connectors[1]
2 = connectors[2]
```

となる。

`left`、`right`、`straight` 等の意味をコネクタ ID に持たせない。

これは `flip` によって左右関係が変化するためである。

---

# 6. 経路（paths）

`paths` は、列車がその部品上を走行できる論理的な経路を表す。

```json
"paths": [
  {
    "from": 0,
    "to": 1,
    "shape": "straight"
  },
  {
    "from": 0,
    "to": 2,
    "shape": "curve"
  }
]
```

`from` と `to` は `connectors` のインデックス。

例えば、

```text
path 0 : connector 0 → connector 1
path 1 : connector 0 → connector 2
```

となる。

`paths` は表示用の画像・モデルとは別物であり、**列車シミュレーションに必要な経路情報**である。

`color` は表示色の任意指定で、指定した場合はその path の中央線に使用する。
省略時はエディタの既定色を使用する。

```json
{
  "from": 0,
  "to": 1,
  "shape": "bezier",
  "color": "#ff6666"
}
```

---

# 7. path の `shape`

v1では最低限、

```text
straight
curve
```

を用意する。

```json
{
  "from": 0,
  "to": 1,
  "shape": "straight",
  "length": 315
}
```

```json
{
  "from": 0,
  "to": 2,
  "shape": "curve"
}
```

分岐側などを緩いS字として表示する場合は `s-curve` を使用する。
`endPosition` が終点を表し、2つの制御点は実装側で自動計算する。
`radius` を指定した場合は、その値を外側への膨らみ量として使用し、制御点を自動計算する。

複数の3次ベジェ曲線を接続し、制御点を部品データに直接記述する場合は `bezier` を使用する。

```json
{
  "from": 0,
  "to": 1,
  "shape": "bezier",
  "segments": [
    {
      "control1": [0, 10],
      "control2": [1.5, 10],
      "endPosition": [1.5, 15]
    }
  ]
}
```

```json
{
  "from": 0,
  "to": 2,
  "shape": "s-curve",
  "endPosition": [10, 2]
}
```

具体的な曲率・半径など、走行軌道を算出するために必要なパラメータは `shape` に応じて追加する。

直線の終点が単純な水平直線ではない場合は、ローカル座標の終点を
`endPosition: [x, y]` で指定できる。省略時は `[length, 0]` とする。

例えば将来的に、

```json
{
  "from": 0,
  "to": 1,
  "shape": "arc",
  "radius": 315
}
```

のようにする。

ここでの geometry は**表示 geometry ではなく走行 geometry**である。

---

# 8. 分岐・ポイント

分岐部品では `switches` を定義する。複数の切り替えポイントを持つ場合は、ポイントごとに要素を追加する。

```json
"switches": [
  {
    "id": "point-1",
    "states": {
      "straight": 0,
      "branch": 1
    },
    "default": "straight"
  },
  {
    "id": "point-2",
    "states": {
      "straight": 0,
      "branch": 2
    },
    "default": "straight"
  }
]
```

`states` の値は `paths` のインデックス。

したがって、

```text
straight → paths[0]
branch   → paths[1]
```

となる。

`straight` や `branch` は**経路の意味**を表すものであり、左右方向を意味しない。

そのため `flip` しても、

```text
straight = path 0
branch   = path 1
```

という意味は変化しない。

---

# 9. レイアウト上のパーツインスタンス

部品定義とは別に、実際に配置されたレールを表現する。

## 9.1 レイアウトファイルのメタデータ

レイアウトファイルのルートには、レイアウト自体の情報を `metadata` として保持する。
現時点ではタイトルと更新日時を使用する。

```json
{
  "schemaVersion": 1,
  "metadata": {
    "title": "",
    "updatedAt": "2026-09-04T00:00:00.000Z"
  },
  "rails": [],
  "connections": []
}
```

### `metadata.title`

レイアウトのタイトル。未設定の場合は空文字列とする。

### `metadata.updatedAt`

ファイルが保存またはダウンロードされた日時。ISO 8601形式の文字列とする。

将来のメタデータ項目は `metadata` 内に追加する。

```json
{
  "id": "rail-001",
  "part": "switch",

  "position": [100, 200, 0],
  "rotation": 90,
  "flip": true,
  "mode": "auto-switch",

  "states": {
    "point-1": "branch",
    "point-2": "straight"
  }
}
```

## `id`

レイアウト内でのレールインスタンスの一意な ID。

## `part`

部品定義の ID。

この例では、

```text
part = "switch"
```

なので、部品 DB から `switch` の定義を取得する。

`part` が `text` の場合は、インスタンスに本文を `text` として保持する。

```json
{
  "id": "text-001",
  "part": "text",
  "position": [100, 200, 0],
  "rotation": 0,
  "flip": false,
  "text": "駅前にカーブを配置"
}
```

## `position`

ワールド座標。

## `rotation`

部品の水平面内での回転角。

角度の基準は `direction` と同じ。

## `flip`

部品ローカル座標系を左右反転する。

v1では、

```text
(x, y, z) → (-x, y, z)
```

を基本とする。ただし、部品定義に `flipHeight` がある場合は、高さ方向もその範囲内で反転する。

```text
(x, y, z) → (-x, y, flipHeight - z)
```

通常のレールでは **z は変化させない**。坂レールのように高低差がある部品では、flip によって高い側と低い側を入れ替える。

これは物理的にレールを裏返すという意味ではなく、エディタ上での**左右反転操作**である。

`rotation` と `flip` は独立した変換として扱う。

## `mode`

ポイントの動作モードを表すオプショナルな項目。ポイント以外のパーツには指定しない。
省略時は通常状態として扱う。値は次の3種類。

```json
"mode": "auto-switch"
```

- `""`: 通常。分岐側から非アクティブなパスへ進入すると、そのパスをアクティブにする。
- `"auto-switch"`: 共通側から列車が通過するたびに、通過後にポイントの状態を次のパスへ切り替える。分岐側から進入した場合は、現在の状態に関係なくそのパスを通過できるが、ポイントの状態は変更しない。
- `"fixed"`: 現在のポイント状態を固定する。分岐側から非アクティブなパスへ進入しても、そのパスを通過できるが、ポイントの状態は変更しない。

---

# 10. flip の適用

`flip` は表示だけに適用してはいけない。

以下すべてに同じ座標変換を適用する。

- connector の位置
- connector の direction
- path geometry
- 表示 geometry

例えば、

```text
(x, y, z) → (-x, y, z)
```

の場合、方向角 `θ` は、

```text
θ' = 180° - θ
```

として変換し、必要に応じて 0～360° に正規化する。

例：

```text
30°  → 150°
90°  → 90°
180° → 0°
```

これにより、接続判定・列車走行・表示が同じ座標系で扱える。

---

# 11. レール同士の接続

レイアウト上の2つのコネクタについて、概ね以下を満たした場合に接続可能とする。

1. ワールド座標上の位置が十分近い
2. `z` が許容誤差内
3. コネクタの方向が互いにほぼ逆向き
4. `end` の組み合わせが接続可能

例えば、

```text
A.direction = 0°
B.direction = 180°
```

なら正しい向き。

完全一致ではなく、実装上は許容誤差を設ける。

接続そのものは、部品の位置関係だけから毎回推測するのではなく、レイアウトデータ上で明示的な接続情報を持つ方式を基本とする。

接続先のコネクタは、レイアウト上のレールIDとコネクタ配列の番号で指定する。
フィールド名は `connector` とする。

```json
{
  "from": { "railId": "rail-001", "connector": 1 },
  "to": { "railId": "rail-002", "connector": 0 }
}
```

---

# 12. 部品定義とレイアウトの責務

### 部品定義

「この種類のレールは何なのか」を定義する。

- 部品 ID
- コネクタ
- 経路
- 分岐状態
- 左右反転可能か

### レイアウト

「そのレールがどこに置かれているか」を定義する。

- インスタンス ID
- 部品 ID
- 位置
- 回転
- 左右反転
- ポイント状態
- 他レールとの接続

---

# 13. 設計上の重要な原則

### 左右を論理情報にしない

`leftConnector`、`rightConnector` のような命名は避ける。

左右は `flip` によって変化するため、論理的な識別子にしない。

### 表示とシミュレーションを分離する

表示モデル・画像は外部 DB。

`paths` は列車が走るための論理 geometry。

### 座標変換はインスタンス側で一括適用する

部品 JSON 自体は常に canonical な状態とする。

```text
part definition
      ↓
flip
      ↓
rotation
      ↓
translation
      ↓
world coordinates
```

### 部品 JSON は再利用可能にする

同じ `part` を複数のレールインスタンスから参照できるようにする。

---

# 14. 最小構成

最初の実装では、部品 JSON を以下までに限定してもよい。

```json
{
  "schemaVersion": 1,
  "type": "rail",
  "id": "straight-315",
  "flippable": true,

  "connectors": [
    {
      "position": [0, 0, 0],
      "direction": 180,
      "end": "male"
    },
    {
      "position": [315, 0, 0],
      "direction": 0,
      "end": "female"
    }
  ],

  "paths": [
    {
      "from": 0,
      "to": 1,
      "shape": "straight"
    }
  ]
}
```

まずはこの形式で、

1. 部品配置
2. `rotation` / `flip`
3. コネクタのスナップ
4. 接続判定
5. レールグラフ生成
6. 列車の走行

まで実装し、曲線の詳細 geometry やポイント制御などは必要になった段階で拡張する。
