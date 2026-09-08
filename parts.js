/* Rail and placeable part definitions. */
const STRAIGHT_LENGTH = 10;
const HALF_STRAIGHT_LENGTH = STRAIGHT_LENGTH / 2;
const QUARTER_STRAIGHT_LENGTH = STRAIGHT_LENGTH / 4;
const SLOPE_LENGTH = STRAIGHT_LENGTH * 2;
const SLOPE_HEIGHT = 10;
const HEIGHT_DISPLAY_SCALE = 0.16;
const SINGLE_DOUBLE_BRANCH_OFFSET = 3;
const U_TURN_CONNECTOR_SPACING = 3;
const TRAIN_WIDTH = 4;
const TRAIN_HEIGHT = 1.5;
const CURVE_RADIUS = 10;
const WIDE_CURVE_RADIUS = 13;
const CURVE_ANGLE_RAD = Math.PI / 4;
const CURVE_SIN = Math.sin(CURVE_ANGLE_RAD);
const CURVE_COS = Math.cos(CURVE_ANGLE_RAD);
const CURVE_45_ENDPOINT = [
  CURVE_RADIUS * CURVE_SIN,
  CURVE_RADIUS * (1 - CURVE_COS)
];
const CURVE_45_ENDPOINT_REVERSED = [CURVE_45_ENDPOINT[0], -CURVE_45_ENDPOINT[1]];
const WIDE_CURVE_45_ENDPOINT = [
  WIDE_CURVE_RADIUS * CURVE_SIN,
  WIDE_CURVE_RADIUS * (1 - CURVE_COS)
];

// Part definitions in canonical local coordinates. Placed values are stored in layout.rails.
window.PARTS = {
  "straight": {
    schemaVersion: 1,
    type: "rail",
    id: "straight",
    name: { ja: "直線", en: "Straight" },
    flippable: false,
    connectors: [
      { position: [0, 0, 0], direction: 180, end: "male" },
      { position: [STRAIGHT_LENGTH, 0, 0], direction: 0, end: "female" }
    ],
    paths: [{ from: 0, to: 1, shape: "straight", length: STRAIGHT_LENGTH }]
  },
  "straight-half": {
    schemaVersion: 1,
    type: "rail",
    id: "straight-half",
    name: { ja: "直線1/2", en: "1/2 Straight" },
    flippable: false,
    connectors: [
      { position: [0, 0, 0], direction: 180, end: "male" },
      { position: [HALF_STRAIGHT_LENGTH, 0, 0], direction: 0, end: "female" }
    ],
    paths: [{ from: 0, to: 1, shape: "straight", length: HALF_STRAIGHT_LENGTH }]
  },
  "straight-quarter": {
    schemaVersion: 1,
    type: "rail",
    id: "straight-quarter",
    name: { ja: "1/4直線", en: "1/4 Straight" },
    flippable: false,
    connectors: [
      { position: [0, 0, 0], direction: 180, end: "male" },
      { position: [QUARTER_STRAIGHT_LENGTH, 0, 0], direction: 0, end: "female" }
    ],
    paths: [{ from: 0, to: 1, shape: "straight", length: QUARTER_STRAIGHT_LENGTH }]
  },
  "straight-quarter-mm": {
    schemaVersion: 1,
    type: "rail",
    id: "straight-quarter-mm",
    name: { ja: "1/4直線(凸凸)", en: "1/4 Straight (M-M)" },
    flippable: false,
    connectors: [
      { position: [0, 0, 0], direction: 180, end: "male" },
      { position: [QUARTER_STRAIGHT_LENGTH, 0, 0], direction: 0, end: "male" }
    ],
    paths: [{ from: 0, to: 1, shape: "straight", length: QUARTER_STRAIGHT_LENGTH }]
  },
  "straight-quarter-ff": {
    schemaVersion: 1,
    type: "rail",
    id: "straight-quarter-ff",
    name: { ja: "1/4直線(凹凹)", en: "1/4 Straight (F-F)" },
    flippable: false,
    connectors: [
      { position: [0, 0, 0], direction: 180, end: "female" },
      { position: [QUARTER_STRAIGHT_LENGTH, 0, 0], direction: 0, end: "female" }
    ],
    paths: [{ from: 0, to: 1, shape: "straight", length: QUARTER_STRAIGHT_LENGTH }]
  },
  "curve": {
    schemaVersion: 1,
    type: "rail",
    id: "curve",
    name: { ja: "カーブ", en: "Curve" },
    flippable: true,
    connectors: [
      { position: [0, 0, 0], direction: 180, end: "male" },
      { position: [...CURVE_45_ENDPOINT, 0], direction: 45, end: "female" }
    ],
    paths: [{ from: 0, to: 1, shape: "curve", radius: CURVE_RADIUS, angle: 45 }]
  },
  "curve-wide": {
    schemaVersion: 1,
    type: "rail",
    id: "curve-wide",
    name: { ja: "複線カーブ", en: "Double-track Curve" },
    flippable: true,
    connectors: [
      { position: [0, 0, 0], direction: 180, end: "male" },
      { position: [...WIDE_CURVE_45_ENDPOINT, 0], direction: 45, end: "female" }
    ],
    paths: [{ from: 0, to: 1, shape: "curve", radius: WIDE_CURVE_RADIUS, angle: 45, color: "#888888" }]
  },
  "slope": {
    schemaVersion: 1,
    type: "rail",
    id: "slope",
    name: { ja: "坂レール", en: "Slope" },
    flippable: true,
    connectors: [
      { position: [0, 0, 0], direction: 180, end: "male" },
      { position: [SLOPE_LENGTH, 0, SLOPE_HEIGHT], direction: 0, end: "female" }
    ],
    paths: [{
      from: 0,
      to: 1,
      shape: "bezier",
      segments: [{
        control1: [SLOPE_LENGTH / 3, 0],
        control2: [SLOPE_LENGTH * 2 / 3, 0]
      }]
    }]
  },
  "turnout-a": {
    schemaVersion: 1,
    type: "rail",
    id: "turnout-a",
    name: { ja: "ターンアウトA", en: "Turnout A" },
    flippable: true,
    connectors: [
      { position: [0, 0, 0], direction: 180, end: "male" },
      { position: [STRAIGHT_LENGTH, 0, 0], direction: 0, end: "female" },
      { position: [...CURVE_45_ENDPOINT, 0], direction: 45, end: "female" }
    ],
    paths: [
      { from: 0, to: 1, shape: "straight", length: STRAIGHT_LENGTH },
      { from: 0, to: 2, shape: "curve", radius: CURVE_RADIUS, angle: 45 }
    ],
    switches: [{
      id: "point",
      connector: 0,
      states: { straight: 0, branch: 1 },
      default: "straight"
    }]
  },
  "turnout-b": {
    schemaVersion: 1,
    type: "rail",
    id: "turnout-b",
    name: { ja: "ターンアウトB", en: "Turnout B" },
    flippable: true,
    connectors: [
      { position: [0, 0, 0], direction: 180, end: "female" },
      { position: [STRAIGHT_LENGTH, 0, 0], direction: 0, end: "male" },
      { position: [...CURVE_45_ENDPOINT, 0], direction: 45, end: "male" }
    ],
    paths: [
      { from: 0, to: 1, shape: "straight", length: STRAIGHT_LENGTH },
      { from: 0, to: 2, shape: "curve", radius: CURVE_RADIUS, angle: 45 }
    ],
    switches: [{
      id: "point",
      connector: 0,
      states: { straight: 0, branch: 1 },
      default: "straight"
    }]
  },
  "y-point-a": {
    schemaVersion: 1,
    type: "rail",
    id: "y-point-a",
    name: { ja: "Y字分岐A", en: "Y-branch A" },
    flippable: true,
    iconViewBox: "-1 -3.8 12 7.6",
    connectors: [
      { position: [0, 0, 0], direction: 180, end: "male" },
      { position: [...CURVE_45_ENDPOINT, 0], direction: 45, end: "female" },
      { position: [...CURVE_45_ENDPOINT_REVERSED, 0], direction: -45, end: "male" }
    ],
    paths: [
      { from: 0, to: 1, shape: "curve", radius: CURVE_RADIUS, angle: 45, side: 1 },
      { from: 0, to: 2, shape: "curve", radius: CURVE_RADIUS, angle: 45, side: -1 }
    ],
    switches: [{
      id: "point",
      connector: 0,
      states: { upper: 0, lower: 1 },
      default: "upper"
    }]
  },
  "y-point-b": {
    schemaVersion: 1,
    type: "rail",
    id: "y-point-b",
    name: { ja: "Y字分岐B", en: "Y-branch B" },
    flippable: true,
    iconViewBox: "-1 -3.8 12 7.6",
    connectors: [
      { position: [0, 0, 0], direction: 180, end: "female" },
      { position: [...CURVE_45_ENDPOINT, 0], direction: 45, end: "male" },
      { position: [...CURVE_45_ENDPOINT_REVERSED, 0], direction: -45, end: "female" }
    ],
    paths: [
      { from: 0, to: 1, shape: "curve", radius: CURVE_RADIUS, angle: 45, side: 1 },
      { from: 0, to: 2, shape: "curve", radius: CURVE_RADIUS, angle: 45, side: -1 }
    ],
    switches: [{
      id: "point",
      connector: 0,
      states: { upper: 0, lower: 1 },
      default: "upper"
    }]
  },
  "single-double-point-a": {
    schemaVersion: 1,
    type: "rail",
    id: "single-double-point-a",
    name: { ja: "単線複線ポイントA", en: "Single-to-Double Point A" },
    flippable: true,
    connectors: [
      { position: [0, 0, 0], direction: 180, end: "male" },
      { position: [STRAIGHT_LENGTH, 0, 0], direction: 0, end: "female" },
      { position: [STRAIGHT_LENGTH, SINGLE_DOUBLE_BRANCH_OFFSET, 0], direction: 0, end: "female" }
    ],
    paths: [
      { from: 0, to: 1, shape: "straight", length: STRAIGHT_LENGTH },
      {
        from: 0,
        to: 2,
        shape: "bezier",
        segments: [{
          control1: [STRAIGHT_LENGTH / 3, 0],
          control2: [STRAIGHT_LENGTH * 2 / 3, SINGLE_DOUBLE_BRANCH_OFFSET]
        }]
      }
    ],
    switches: [{
      id: "point",
      connector: 0,
      states: { straight: 0, branch: 1 },
      default: "straight"
    }]
  },
  "single-double-point-b": {
    schemaVersion: 1,
    type: "rail",
    id: "single-double-point-b",
    name: { ja: "単線複線ポイントB", en: "Single-to-Double Point B" },
    flippable: true,
    connectors: [
      { position: [0, 0, 0], direction: 180, end: "female" },
      { position: [STRAIGHT_LENGTH, 0, 0], direction: 0, end: "male" },
      { position: [STRAIGHT_LENGTH, SINGLE_DOUBLE_BRANCH_OFFSET, 0], direction: 0, end: "male" }
    ],
    paths: [
      { from: 0, to: 1, shape: "straight", length: STRAIGHT_LENGTH },
      {
        from: 0,
        to: 2,
        shape: "bezier",
        segments: [{
          control1: [STRAIGHT_LENGTH / 3, 0],
          control2: [STRAIGHT_LENGTH * 2 / 3, SINGLE_DOUBLE_BRANCH_OFFSET]
        }]
      }
    ],
    switches: [{
      id: "point",
      connector: 0,
      states: { straight: 0, branch: 1 },
      default: "straight"
    }]
  },
  "u-turn": {
    schemaVersion: 1,
    type: "rail",
    id: "u-turn",
    name: { ja: "Uターン", en: "U-turn" },
    flippable: false,
    connectors: [
      { position: [0, 0, 0], direction: 180, end: "female" },
      { position: [0, U_TURN_CONNECTOR_SPACING, 0], direction: 180, end: "female" }
    ],
    paths: [{
      from: 0,
      to: 1,
      shape: "bezier",
      color: "#ff6666",
      segments: [
        {
          control1: [5, 0],
          control2: [7.239, -3.5],
          endPosition: [10, -3.5]
        },
        {
          control1: [12.761, -3.5],
          control2: [15, -1.261],
          endPosition: [15, 1.5]
        },
        {
          control1: [15, 4.261],
          control2: [12.761, 6.5],
          endPosition: [10, 6.5]
        },
        {
          control1: [7.239, 6.5],
          control2: [5, 3]
        }
      ]
    }]
  },
  "cross-point": {
    schemaVersion: 1,
    type: "rail",
    id: "cross-point",
    name: { ja: "交差ポイント", en: "Crossing Point" },
    flippable: true,
    iconViewBox: `-1 ${-(STRAIGHT_LENGTH / 2 + 1)} ${STRAIGHT_LENGTH + 2} ${STRAIGHT_LENGTH + 2}`,
    connectors: [
      { position: [0, 0, 0], direction: 180, end: "male" },
      { position: [STRAIGHT_LENGTH, 0, 0], direction: 0, end: "female" },
      { position: [STRAIGHT_LENGTH / 2, STRAIGHT_LENGTH / 2, 0], direction: 90, end: "female" },
      { position: [STRAIGHT_LENGTH / 2, -STRAIGHT_LENGTH / 2, 0], direction: -90, end: "male" }
    ],
    paths: [
      { from: 0, to: 1, shape: "straight" },
      { from: 3, to: 2, shape: "straight" },
      {
        from: 0,
        to: 3,
        shape: "curve",
        radius: STRAIGHT_LENGTH / 2,
        angle: 90,
        side: -1
      },
      {
        from: 1,
        to: 2,
        shape: "curve",
        radius: STRAIGHT_LENGTH / 2,
        angle: 90,
        side: -1
      }
    ],
    switches: [
      {
        id: "point1",
        connector: 0,
        states: { straight: 0, branch: 2 },
        default: "straight"
      },
      {
        id: "point2",
        connector: 1,
        states: { straight: 1, branch: 3 },
        default: "straight"
      }
    ]
  },
  "text": {
    schemaVersion: 1,
    type: "text",
    id: "text",
    name: { ja: "コメント", en: "Comment" },
    color: "#4c5b73",
    fontSize: 1.2,
    flippable: false,
    connectors: []
  },
  "train": {
    schemaVersion: 1,
    type: "train",
    id: "train",
    name: { ja: "列車", en: "Train" },
    color: "#d42e51",
    colors: [
      { id: "red", color: "#d42e51", name: { ja: "赤", en: "Red" } },
      { id: "orange", color: "#f4a261", name: { ja: "オレンジ", en: "Orange" } },
      { id: "blue", color: "#3f6fba", name: { ja: "青", en: "Blue" } },
      { id: "light-green", color: "#269c86", name: { ja: "ライトグリーン", en: "Light Green" } },
      { id: "yellow", color: "#ecda04", name: { ja: "黄色", en: "Yellow" } },
      { id: "white", color: "#ffffff", name: { ja: "白", en: "White" } }
    ],
    size: [TRAIN_WIDTH, TRAIN_HEIGHT],
    flippable: false,
    connectors: []
  }
};
