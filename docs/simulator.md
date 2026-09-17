# シミュレータ API

## 概要

シミュレーションエンジンは `simulator.js` の `createLayoutSimulator` で生成します。時間の進行はエンジン外から `update(deltaTime)` を呼び出して行います。

エンジンはレイアウトや部品定義を直接参照します。レイアウトオブジェクト自体を差し替える場合は、シミュレータも再生成してください。

## 生成

```js
const simulator = createLayoutSimulator({
  layout,
  parts,
  maxStepDeltaTime: 0.1,
  onStateChange: playing => {
    // 開始時・停止時に呼ばれる
  }
});
```

### オプション

- `layout`: レイアウトオブジェクト。`rails` と `connections` を持つ
- `parts`: 部品定義の辞書。コネクタ、走行経路、分岐定義などを含む
- `maxStepDeltaTime`: 内部サブステップの最大時間（秒）。省略時は `0.1`
- `onStateChange(playing)`: シミュレーションの開始・リセット時に呼ばれる任意のコールバック

## 操作 API

```js
simulator.start();
const frame = simulator.update(deltaTime);
simulator.reset();
simulator.isPlaying();
```

- `start()`
  - シミュレーションを開始する
  - 開始できた場合は `true`、すでに実行中の場合は `false`
- `update(deltaTime)`
  - シミュレーションを1回更新し、更新後のフレームを返す
  - `deltaTime` は秒単位
  - 未開始または `reset()` 後は `null`
  - `maxStepDeltaTime` を超える値は、内部で複数のサブステップに分けて処理する
- `reset()`
  - 現在のシミュレーションを終了する
  - シミュレーション開始時のポイント状態を復元する
  - 実行中に呼ぶと、状態を破棄してから復元する
- `isPlaying()`
  - シミュレーションが開始済みで、`reset()` されていなければ `true`

## フレーム形式

```js
{
  elapsed: 1.25,
  revision: 3,
  trains: {
    "train-001": {
      position: [x, y, z],
      rotation: 90,
      flip: false,
      status: "running"
    }
  }
}
```

- `elapsed`: シミュレーション経過時間。再生速度を反映した値
- `revision`: ポイント状態など、レイアウト側の論理状態が変化した回数
- `trains`: 列車 ID ごとの位置・向き・状態

## 外部タイマーからの利用

ブラウザ版では `app.js` が `requestAnimationFrame` を管理し、各フレームで `update()` を呼び出します。

```js
const speedMultiplier = 4;
let previousTime = performance.now();

function tick(time) {
  const deltaTime = (time - previousTime) / 1000 * speedMultiplier;
  previousTime = time;

  const frame = simulator.update(deltaTime);
  // frame を描画やログ保存に利用する

  if (simulator.isPlaying()) requestAnimationFrame(tick);
}

simulator.start();
requestAnimationFrame(tick);
```

一時停止する場合は、外部タイマーから `update()` を呼ばないだけで構いません。再開時は同じシミュレータに対して `update()` を再び呼び出します。`reset()` を呼ぶと現在の走行状態が破棄されるため、再開するには `start()` を呼び直します。

再生速度を変更する場合は、呼び出し側で `deltaTime` に倍率を掛けます。例えば `speedMultiplier = 4` とすると、4倍速になります。

固定刻みで実行する場合は、例えば次のように呼び出します。

```js
simulator.update(1 / 60);
```

## Node.js での利用

`simulator.js` は CommonJS の `require` で読み込めます。

```js
const { createLayoutSimulator } = require("./simulator.js");
const speedMultiplier = 1;

const simulator = createLayoutSimulator({ layout, parts });
simulator.start();

setInterval(() => {
  const frame = simulator.update((1 / 60) * speedMultiplier);
  // frame を処理する
}, 1000 / 60);
```

`parts.js` はブラウザの `window.PARTS` に部品定義を登録する形式です。Node.js では、部品定義を別途読み込んで `parts` として渡すか、部品定義側を Node.js のモジュール形式に変換してください。
