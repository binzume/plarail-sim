/* Plarail layout simulator / vanilla JS + SVG */

const SVG_NS = "http://www.w3.org/2000/svg";
const BASE_VIEWBOX = { x: 0, y: 0, width: 48, height: 28 };
const DEFAULT_ZOOM = 1;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 3;
const MM_PER_UNIT = 216 / 10;
const SNAP_DISTANCE = 24 / MM_PER_UNIT;
const ANGLE_TOLERANCE = 22.5;
const POSITION_STEP = 0.5;
const PARTS = window.PARTS;
// samples.js is optional; an unavailable or invalid sample bundle means no sample entries.
const SAMPLES = Array.isArray(window.SAMPLES) ? window.SAMPLES : [];
const SWITCH_MODES = ["", "auto-switch", "fixed"];

function isRailPart(partId) {
  return PARTS[partId]?.type === "rail";
}

function isPlaceablePart(partId) {
  return isRailPart(partId) || ["train", "text"].includes(PARTS[partId]?.type);
}

function switchModeForRail(rail) {
  return SWITCH_MODES.includes(rail.mode) ? rail.mode : "";
}

function storedSwitchMode(rail) {
  const mode = switchModeForRail(rail);
  return switchDefinitions(rail.part).length > 0 && mode ? { mode } : {};
}

function trainColorForRail(rail) {
  const part = PARTS[rail.part];
  return typeof rail?.color === "string" && rail.color.length > 0
    ? rail.color
    : part?.color;
}

function textMetrics(value, part) {
  const fontSize = part.fontSize ?? 1.2;
  const lines = String(value || "").split(/\r?\n/);
  const width = Math.max(3, ...lines.map(line => Math.max(1, line.length * fontSize * .65))) + .8;
  const height = Math.max(fontSize * 1.4, lines.length * fontSize * 1.25) + .6;
  return { fontSize, lines, width, height, lineHeight: fontSize * 1.25 };
}

const ROUTE_MAX_CURVES = 8;
const ROUTE_MAX_STRAIGHTS = 24;
const ROUTE_DRAG_THRESHOLD = 0.35;
const layout = {
  schemaVersion: 1,
  metadata: { title: "", updatedAt: null },
  rails: [],
  connections: []
};
const state = { selectedRailId: null, selectedRailIds: [], drag: null, routeDrag: null, paletteDrag: null, pan: null, selectionDrag: null, justDragged: false, justRouteDragged: false, justPaletteDragged: false, justPanned: false, justRangeSelected: false, idCounter: 1 };
const history = { undo: [], redo: [], applying: false };
const HISTORY_LIMIT = 100;
const viewState = { zoom: 1, viewBox: { ...BASE_VIEWBOX } };
const LAYOUT_DB_NAME = "plarail-layout";
const LAYOUT_DB_VERSION = 1;
const LAYOUT_STORE_NAME = "layouts";
const CURRENT_LAYOUT_ID = "current";
const SAVE_DEBOUNCE_MS = 5000;
let layoutDb = null;
let layoutSaveTimer = null;
let layoutSavePromise = Promise.resolve();
let latestSaveRequest = 0;
let isLoadingLayout = true;

const canvas = document.querySelector("#layout-canvas");
const canvasWrap = document.querySelector(".canvas-wrap");
const railLayer = document.querySelector("#rail-layer");
const connectionLayer = document.querySelector("#connection-layer");
const routePreviewLayer = document.querySelector("#route-preview-layer");
const selectionLayer = document.querySelector("#selection-layer");
const inspector = document.querySelector("#inspector-content");
const emptyState = document.querySelector("#empty-state");
const railCount = document.querySelector("#rail-count");
const selectionControls = document.querySelector("#selection-controls");
const selectionMenu = document.querySelector("#selection-menu");
const selectionMenuButton = selectionMenu.querySelector(".menu-button");
const selectionMenuPopup = document.querySelector("#selection-menu-popup");
const loadMenu = document.querySelector("#load-menu");
const loadMenuButton = loadMenu.querySelector("[data-action='toggle-load-menu']");
const loadMenuPopup = document.querySelector("#load-menu-popup");
const sampleList = document.querySelector("#sample-list");
const loadMenuDivider = document.querySelector("#load-menu-divider");
const layoutFileInput = document.querySelector("#layout-file-input");
const saveStatusDot = document.querySelector("#save-status-dot");
const playButton = document.querySelector("[data-action='toggle-play']");
const simulationPanel = document.querySelector("#simulation-panel");
const simulationTimeValue = document.querySelector("#simulation-time-value");
const simulationSpeedSelect = document.querySelector("#simulation-speed-select");
let simulationFrame = null;
let lastRenderedSimulationRevision = null;

const simulator = window.createLayoutSimulator({
  getLayout: () => layout,
  getParts: () => PARTS,
  onFrame: frame => {
    simulationFrame = frame;
    if (frame) {
      simulationTimeValue.textContent = formatSimulationTime(frame.elapsed);
      simulationSpeedSelect.value = String(frame.speed);
    } else {
      simulationTimeValue.textContent = "00:00";
    }
    const updateInspector = !frame || frame.revision !== lastRenderedSimulationRevision;
    render(updateInspector);
    lastRenderedSimulationRevision = frame ? frame.revision : null;
  },
  onStateChange: playing => {
    playButton.textContent = playing ? "■" : "▶";
    playButton.title = playing ? "停止" : "再生";
    playButton.setAttribute("aria-label", playing ? "シミュレーションを停止" : "シミュレーションを再生");
    simulationPanel.hidden = !playing;
  }
});

function formatSimulationTime(seconds) {
  const totalSeconds = Math.floor(seconds || 0);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = String(totalSeconds % 60).padStart(2, "0");
  return `${String(minutes).padStart(2, "0")}:${remainingSeconds}`;
}

function displayedPartInstance(partInstance) {
  const frame = simulationFrame?.trains?.[partInstance.id];
  if (!frame) return partInstance;
  return {
    ...partInstance,
    position: [...frame.position],
    rotation: frame.rotation,
    flip: frame.flip
  };
}

function stopSimulation() {
  const initialSwitches = simulator.stop();
  initialSwitches.forEach(snapshot => {
    const rail = railById(snapshot.id);
    if (!rail) return;
    if (snapshot.hadStates) rail.states = { ...snapshot.states };
    else delete rail.states;
  });
  simulationFrame = null;
  render();
}

function openLayoutDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    let request;
    try {
      request = window.indexedDB.open(LAYOUT_DB_NAME, LAYOUT_DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LAYOUT_STORE_NAME)) {
        database.createObjectStore(LAYOUT_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readCurrentLayout(database) {
  return indexedDbRequest(
    database.transaction(LAYOUT_STORE_NAME, "readonly")
      .objectStore(LAYOUT_STORE_NAME)
      .get(CURRENT_LAYOUT_ID),
    result => result || null
  );
}

function writeCurrentLayout(database, record) {
  return indexedDbRequest(
    database.transaction(LAYOUT_STORE_NAME, "readwrite")
      .objectStore(LAYOUT_STORE_NAME)
      .put(record),
    () => undefined
  );
}

function indexedDbRequest(request, transform = result => result) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(transform(request.result));
    request.onerror = () => reject(request.error);
  });
}

function layoutSnapshot() {
  return {
    schemaVersion: layout.schemaVersion,
    metadata: {
      title: layout.metadata?.title || "",
      updatedAt: layout.metadata?.updatedAt || null
    },
    rails: layout.rails.map(rail => {
      const { mode, ...railData } = rail;
      return {
        ...railData,
        ...storedSwitchMode(rail),
        position: rail.position.map(roundCoordinate),
        ...(rail.states ? { states: { ...rail.states } } : {})
      };
    }),
    connections: layout.connections.map(connection => cloneConnection(connection))
  };
}

function layoutFileData() {
  const snapshot = layoutSnapshot();
  return {
    ...snapshot,
    metadata: {
      ...snapshot.metadata,
      updatedAt: new Date().toISOString()
    }
  };
}

function pushHistoryIfChanged(snapshot) {
  if (JSON.stringify(snapshot) !== JSON.stringify(layoutSnapshot())) pushHistory(snapshot);
}

function discardLastHistoryIfSame(snapshot) {
  if (history.undo.at(-1) && JSON.stringify(history.undo.at(-1)) === JSON.stringify(snapshot)) {
    history.undo.pop();
  }
}

function pushHistory(snapshot) {
  if (history.applying) return;
  history.undo.push(snapshot);
  if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  history.redo = [];
}

function restoreHistorySnapshot(snapshot) {
  const normalized = normalizeLayout(snapshot);
  if (!normalized) return false;
  layout.rails = normalized.rails;
  layout.connections = normalized.connections;
  layout.metadata = normalized.metadata;
  state.selectedRailId = null;
  state.selectedRailIds = [];
  scheduleLayoutSave();
  render();
  return true;
}

function undoLayout() {
  if (!history.undo.length) return;
  const snapshot = history.undo.pop();
  const current = layoutSnapshot();
  history.applying = true;
  const restored = restoreHistorySnapshot(snapshot);
  history.applying = false;
  if (!restored) {
    history.undo.push(snapshot);
    return;
  }
  history.redo.push(current);
}

function redoLayout() {
  if (!history.redo.length) return;
  const snapshot = history.redo.pop();
  const current = layoutSnapshot();
  history.applying = true;
  const restored = restoreHistorySnapshot(snapshot);
  history.applying = false;
  if (!restored) {
    history.redo.push(snapshot);
    return;
  }
  history.undo.push(current);
}

function cloneConnection(connection, railIdMap = null) {
  const cloneRef = ref => ({
    ...ref,
    ...(railIdMap ? { railId: railIdMap.get(ref.railId) } : {})
  });
  return { from: cloneRef(connection.from), to: cloneRef(connection.to) };
}

function roundCoordinate(value) {
  return Number(value.toFixed(3));
}

function isValidRailData(rail, knownIds = null) {
  return rail && typeof rail.id === "string" && !knownIds?.has(rail.id) &&
    isPlaceablePart(rail.part) && Array.isArray(rail.position) && rail.position.length >= 3 &&
    rail.position.slice(0, 3).every(Number.isFinite) && Number.isFinite(rail.rotation);
}

function isValidConnectionData(connection, railsById) {
  if (!connection?.from || !connection?.to) return false;
  const { from, to } = connection;
  const fromRail = railsById.get(from.railId);
  const toRail = railsById.get(to.railId);
  const fromConnectors = PARTS[fromRail?.part]?.connectors || [];
  const toConnectors = PARTS[toRail?.part]?.connectors || [];
  return fromRail && toRail && from.railId !== to.railId &&
    Number.isInteger(from.connector) && Number.isInteger(to.connector) &&
    fromConnectors[from.connector] && toConnectors[to.connector];
}

function normalizeLayout(savedLayout) {
  if (!savedLayout || savedLayout.schemaVersion !== layout.schemaVersion || !Array.isArray(savedLayout.rails)) return null;
  const usedIds = new Set();
  const rails = savedLayout.rails.filter(rail => {
    if (!isValidRailData(rail, usedIds)) return false;
    usedIds.add(rail.id);
    return true;
  }).map(rail => {
    const switchStates = switchStatesForRail(rail);
    return {
      id: rail.id,
      part: rail.part,
      position: rail.position.slice(0, 3).map(roundCoordinate),
      rotation: rail.rotation,
      flip: Boolean(rail.flip),
      ...storedSwitchMode(rail),
      ...(PARTS[rail.part].type === "train" ? { color: trainColorForRail(rail) } : {}),
      ...(PARTS[rail.part].type === "text" ? { text: typeof rail.text === "string" ? rail.text : "" } : {}),
      ...(Object.keys(switchStates).length ? { states: switchStates } : {})
    };
  });
  const railsById = new Map(rails.map(rail => [rail.id, rail]));
  const connections = Array.isArray(savedLayout.connections)
    ? savedLayout.connections
      .filter(connection => isValidConnectionData(connection, railsById))
      .map(connection => cloneConnection(connection))
    : [];
  const metadata = savedLayout.metadata && typeof savedLayout.metadata === "object"
    ? savedLayout.metadata
    : {};
  return {
    schemaVersion: layout.schemaVersion,
    metadata: {
      title: typeof metadata.title === "string" ? metadata.title : "",
      updatedAt: typeof metadata.updatedAt === "string" ? metadata.updatedAt : null
    },
    rails,
    connections
  };
}

function restoreLayout(savedLayout) {
  const normalized = normalizeLayout(savedLayout);
  if (!normalized) return false;
  layout.rails = normalized.rails;
  layout.connections = normalized.connections;
  layout.metadata = normalized.metadata;
  return true;
}

function setSaveStatus(saved) {
  saveStatusDot.classList.toggle("is-saved", saved);
}

function importLayoutData(data, append) {
  const normalized = normalizeLayout(data);
  if (!normalized) return false;
  const historyBefore = layoutSnapshot();

  if (!append) {
    layout.rails = normalized.rails;
    layout.connections = normalized.connections;
    layout.metadata = normalized.metadata;
  } else {
    const idMap = new Map();
    const importedRails = normalized.rails.map(sourceRail => {
      const rail = {
        ...sourceRail,
        id: nextId(),
        position: [...sourceRail.position],
        ...(sourceRail.states ? { states: { ...sourceRail.states } } : {})
      };
      idMap.set(sourceRail.id, rail.id);
      return rail;
    });
    const importedConnections = normalized.connections.map(connection => cloneConnection(connection, idMap));
    layout.rails.push(...importedRails);
    layout.connections.push(...importedConnections);
  }

  state.selectedRailId = null;
  state.selectedRailIds = [];
  pushHistoryIfChanged(historyBefore);
  scheduleLayoutSave();
  fitLayout();
  render();
  return true;
}

async function importDroppedLayout(file, append) {
  try {
    const data = JSON.parse(await file.text());
    if (!importLayoutData(data, append)) throw new Error("Invalid layout data");
  } catch (error) {
    console.error("Failed to import layout JSON", error);
  }
}

function isJsonFile(file) {
  return Boolean(file) && (file.type === "application/json" || file.name.toLowerCase().endsWith(".json"));
}

async function loadSavedLayout() {
  try {
    layoutDb = await openLayoutDatabase();
    const record = await readCurrentLayout(layoutDb);
    setSaveStatus(Boolean(record?.layout && restoreLayout(record.layout)));
  } catch {
    layoutDb = null;
    setSaveStatus(false);
  }
}

function saveLayout() {
  if (isLoadingLayout) return;
  const saveRequest = ++latestSaveRequest;
  setSaveStatus(false);
  const record = {
    id: CURRENT_LAYOUT_ID,
    updatedAt: Date.now(),
    layout: layoutFileData()
  };
  layoutSavePromise = layoutSavePromise.catch(() => {}).then(async () => {
    try {
      if (!layoutDb) layoutDb = await openLayoutDatabase();
      await writeCurrentLayout(layoutDb, record);
      if (saveRequest === latestSaveRequest) setSaveStatus(true);
    } catch {
      layoutDb = null;
      if (saveRequest === latestSaveRequest) setSaveStatus(false);
    }
  });
}

function scheduleLayoutSave() {
  if (isLoadingLayout) return;
  setSaveStatus(false);
  window.clearTimeout(layoutSaveTimer);
  layoutSaveTimer = window.setTimeout(() => {
    layoutSaveTimer = null;
    saveLayout();
  }, SAVE_DEBOUNCE_MS);
}

function flushLayoutSave() {
  if (layoutSaveTimer !== null) {
    window.clearTimeout(layoutSaveTimer);
    layoutSaveTimer = null;
  }
  saveLayout();
}

function createSvg(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
}

function normalizeAngle(angle) {
  return ((angle % 360) + 360) % 360;
}

function snapPosition(value) {
  return Math.round(value / POSITION_STEP) * POSITION_STEP;
}

function angleDifference(a, b) {
  const difference = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return Math.min(difference, 360 - difference);
}

function transformPoint(point, rail) {
  const part = PARTS[rail.part];
  let [x, y, z] = point;
  if (rail.flip) {
    x = -x;
    if (part.flipHeight !== undefined) z = part.flipHeight - z;
  }
  const radians = rail.rotation * Math.PI / 180;
  return {
    x: rail.position[0] + x * Math.cos(radians) - y * Math.sin(radians),
    y: rail.position[1] + x * Math.sin(radians) + y * Math.cos(radians),
    z: rail.position[2] + z
  };
}

function projectWorldPoint(point) {
  return {
    ...point,
    y: point.y - point.z * HEIGHT_DISPLAY_SCALE
  };
}

function logicalPointAtHeight(point, z) {
  return {
    x: point.x,
    y: point.y + z * HEIGHT_DISPLAY_SCALE
  };
}

function transformDirection(direction, rail) {
  const flipped = rail.flip ? 180 - direction : direction;
  return normalizeAngle(flipped + rail.rotation);
}

function worldConnector(rail, connectorIndex) {
  const connector = PARTS[rail.part].connectors[connectorIndex];
  return {
    ...transformPoint(connector.position, rail),
    direction: transformDirection(connector.direction, rail),
    end: connector.end,
    railId: rail.id,
    connector: connectorIndex
  };
}

function averageConnectorHeight(rail) {
  const connectors = PARTS[rail.part]?.connectors || [];
  if (!connectors.length) return rail.position[2];
  return connectors.reduce((sum, connector, index) => sum + worldConnector(rail, index).z, 0) / connectors.length;
}

function railById(id) {
  return layout.rails.find(rail => rail.id === id);
}

function switchDefinitions(partId) {
  return PARTS[partId]?.switches || [];
}

function switchStateForRail(rail, switchId) {
  const definition = switchDefinitions(rail.part).find(item => item.id === switchId);
  if (!definition) return null;
  const state = rail.states?.[switchId];
  return Object.prototype.hasOwnProperty.call(definition.states, state)
    ? state
    : definition.default;
}

function switchStatesForRail(rail) {
  return Object.fromEntries(
    switchDefinitions(rail.part).map(definition => [
      definition.id,
      switchStateForRail(rail, definition.id)
    ])
  );
}

function connectionFor(railId, connectorIndex) {
  return layout.connections.find(connection =>
    (connection.from.railId === railId && connection.from.connector === connectorIndex) ||
    (connection.to.railId === railId && connection.to.connector === connectorIndex)
  );
}

function nextId() {
  let id;
  do { id = `rail-${String(state.idCounter++).padStart(3, "0")}`; } while (railById(id));
  return id;
}

function centeredOrder(index) {
  if (index === 0) return 0;
  return index % 2 === 1 ? -(index + 1) / 2 : index / 2;
}

function addRail(partId, dropPoint = null) {
  if (!isPlaceablePart(partId)) return null;
  const historyBefore = layoutSnapshot();
  const index = layout.rails.length;
  const position = dropPoint
    ? [dropPoint.x, dropPoint.y, 0]
    : (() => {
      const centerX = viewState.viewBox.x + viewState.viewBox.width / 2;
      const centerY = viewState.viewBox.y + viewState.viewBox.height / 2;
      const column = centeredOrder(index % 3);
      const row = centeredOrder(Math.floor(index / 3));
      return [centerX + column * 12, centerY + row * 6, 0];
    })();
  const switchStates = switchStatesForRail({ part: partId });
  const rail = {
    id: nextId(),
    part: partId,
    position,
    rotation: 0,
    flip: false,
    ...(PARTS[partId].type === "train" ? { color: PARTS[partId].color } : {}),
    ...(PARTS[partId].type === "text" ? { text: "" } : {}),
    ...(Object.keys(switchStates).length ? { states: switchStates } : {})
  };
  layout.rails.push(rail);
  state.selectedRailId = rail.id;
  state.selectedRailIds = [rail.id];
  pushHistoryIfChanged(historyBefore);
  scheduleLayoutSave();
  render();
  return rail;
}

function partLabel(partId) {
  return PARTS[partId]?.name?.ja || partId;
}

function partEnglishLabel(partId) {
  return PARTS[partId]?.name?.en || partId;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[character]));
}

function removeSelectedRail() {
  const ids = state.selectedRailIds.length ? state.selectedRailIds : (state.selectedRailId ? [state.selectedRailId] : []);
  if (!ids.length) return;
  const historyBefore = layoutSnapshot();
  layout.rails = layout.rails.filter(rail => !ids.includes(rail.id));
  layout.connections = layout.connections.filter(connection => !ids.includes(connection.from.railId) && !ids.includes(connection.to.railId));
  state.selectedRailId = null;
  state.selectedRailIds = [];
  pushHistoryIfChanged(historyBefore);
  scheduleLayoutSave();
  render();
}

function selectedRailClipboardData() {
  const selectedIds = new Set(
    state.selectedRailIds.length ? state.selectedRailIds : (state.selectedRailId ? [state.selectedRailId] : [])
  );
  if (!selectedIds.size) return null;
  const rails = layout.rails
    .filter(rail => selectedIds.has(rail.id))
    .map(rail => ({ ...rail, position: rail.position.map(roundCoordinate) }));
  if (!rails.length) return null;
  const connections = layout.connections
    .filter(connection => selectedIds.has(connection.from.railId) && selectedIds.has(connection.to.railId))
    .map(connection => cloneConnection(connection));
  return { schemaVersion: 1, rails, connections };
}

function parseRailClipboardData(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.rails) || !data.rails.length) return null;

  const sourceRails = new Map();
  for (const rail of data.rails) {
    if (!isValidRailData(rail, sourceRails)) return null;
    sourceRails.set(rail.id, rail);
  }

  const connections = Array.isArray(data.connections) ? data.connections.filter(connection => {
    return isValidConnectionData(connection, sourceRails);
  }).map(connection => cloneConnection(connection)) : [];

  return { rails: [...sourceRails.values()], connections };
}

function pasteRailClipboardData(data) {
  const historyBefore = layoutSnapshot();
  const idMap = new Map();
  const pastedRails = data.rails.map(sourceRail => {
    const switchStates = switchStatesForRail(sourceRail);
    const rail = {
      id: nextId(),
      part: sourceRail.part,
      position: [sourceRail.position[0] + 2, sourceRail.position[1] + 2, sourceRail.position[2]],
      rotation: sourceRail.rotation,
      flip: Boolean(sourceRail.flip),
      ...storedSwitchMode(sourceRail),
      ...(PARTS[sourceRail.part].type === "train" ? { color: trainColorForRail(sourceRail) } : {}),
      ...(PARTS[sourceRail.part].type === "text" ? { text: typeof sourceRail.text === "string" ? sourceRail.text : "" } : {}),
      ...(Object.keys(switchStates).length ? { states: switchStates } : {})
    };
    idMap.set(sourceRail.id, rail.id);
    layout.rails.push(rail);
    return rail;
  });
  data.connections.forEach(connection => {
    layout.connections.push({
      from: { railId: idMap.get(connection.from.railId), connector: connection.from.connector },
      to: { railId: idMap.get(connection.to.railId), connector: connection.to.connector }
    });
  });
  state.selectedRailId = pastedRails[0].id;
  state.selectedRailIds = pastedRails.map(rail => rail.id);
  pushHistoryIfChanged(historyBefore);
  scheduleLayoutSave();
  render();
}

function rotateSelected(delta) {
  const rail = railById(state.selectedRailId);
  if (!rail) return;
  const historyBefore = layoutSnapshot();
  const rails = layout.rails.filter(item => state.selectedRailIds.includes(item.id));
  if (rails.length > 1) {
    const center = {
      x: rails.reduce((sum, item) => sum + item.position[0], 0) / rails.length,
      y: rails.reduce((sum, item) => sum + item.position[1], 0) / rails.length
    };
    rails.forEach(item => {
      const radians = delta * Math.PI / 180;
      const dx = item.position[0] - center.x;
      const dy = item.position[1] - center.y;
      item.position[0] = center.x + dx * Math.cos(radians) - dy * Math.sin(radians);
      item.position[1] = center.y + dx * Math.sin(radians) + dy * Math.cos(radians);
      item.rotation = normalizeAngle(item.rotation + delta);
    });
    rails.forEach(item => detachInvalidConnections(item.id));
  } else {
    rail.rotation = normalizeAngle(rail.rotation + delta);
    detachInvalidConnections(rail.id);
  }
  pushHistoryIfChanged(historyBefore);
  scheduleLayoutSave();
  render();
}

function flipSelected() {
  const rail = railById(state.selectedRailId);
  if (!rail) return;
  if (!PARTS[rail.part].flippable) return;
  const rails = layout.rails.filter(item => state.selectedRailIds.includes(item.id));
  const nonFlippable = rails.find(item => !PARTS[item.part].flippable);
  if (nonFlippable) return;
  const historyBefore = layoutSnapshot();
  rails.forEach(item => {
    item.flip = !item.flip;
  });
  rails.forEach(item => detachInvalidConnections(item.id));
  pushHistoryIfChanged(historyBefore);
  scheduleLayoutSave();
  render();
}

function detachInvalidConnections(railId) {
  const connectionCount = layout.connections.length;
  layout.connections = layout.connections.filter(connection => {
    if (connection.from.railId !== railId && connection.to.railId !== railId) return true;
    return isConnectionValid(connection.from, connection.to);
  });
  if (layout.connections.length !== connectionCount) resetConnectedGroupHeight(railId);
}

function isConnectionValid(aRef, bRef) {
  const a = railById(aRef.railId);
  const b = railById(bRef.railId);
  if (!a || !b || a.id === b.id) return false;
  const aConnector = worldConnector(a, aRef.connector);
  const bConnector = worldConnector(b, bRef.connector);
  const distance = Math.hypot(aConnector.x - bConnector.x, aConnector.y - bConnector.y);
  return distance <= SNAP_DISTANCE &&
    Math.abs(aConnector.z - bConnector.z) <= 1 &&
    angleDifference(aConnector.direction, bConnector.direction + 180) <= ANGLE_TOLERANCE &&
    aConnector.end !== bConnector.end;
}

function connectorRefsEqual(a, b) {
  return a && b && a.railId === b.railId && a.connector === b.connector;
}

function removeConnectionBetween(first, second) {
  const connectionCount = layout.connections.length;
  layout.connections = layout.connections.filter(connection => {
    const sameDirection = connectorRefsEqual(connection.from, first) && connectorRefsEqual(connection.to, second);
    const reverseDirection = connectorRefsEqual(connection.from, second) && connectorRefsEqual(connection.to, first);
    return !sameDirection && !reverseDirection;
  });
  return layout.connections.length !== connectionCount;
}

function connectNearbyUnconnectedConnectors(movingRailIds) {
  const connections = [];
  let best;
  while ((best = findBestNearbyConnection(movingRailIds, (moving, anchor) => isConnectionValid(moving, anchor)))) {
    layout.connections.push({ from: { ...best.anchor }, to: { ...best.moving } });
    connections.push({ anchor: { ...best.anchor }, moving: { ...best.moving } });
  }
  return connections;
}

function removeSnapConnections(snapLock) {
  const connections = snapLock.connections || [{ anchor: snapLock.anchor, moving: snapLock.moving }];
  let removed = false;
  connections.forEach(connection => {
    removed = removeConnectionBetween(connection.anchor, connection.moving) || removed;
  });
  if (removed) resetConnectedGroupHeight(snapLock.moving.railId);
}

function snapRailToConnector(anchorRail, anchorIndex, movingRail, movingIndex) {
  const anchor = worldConnector(anchorRail, anchorIndex);
  const movingBaseDirection = transformDirection(PARTS[movingRail.part].connectors[movingIndex].direction, movingRail);
  const desiredDirection = normalizeAngle(anchor.direction + 180);
  let rotationDelta = normalizeAngle(desiredDirection - movingBaseDirection);
  if (rotationDelta > 180) rotationDelta -= 360;
  movingRail.rotation = normalizeAngle(movingRail.rotation + rotationDelta);
  const afterRotation = worldConnector(movingRail, movingIndex);
  movingRail.position[0] += anchor.x - afterRotation.x;
  movingRail.position[1] += anchor.y - afterRotation.y;
  movingRail.position[2] = anchor.z - (afterRotation.z - movingRail.position[2]);
}

function connectAllPossible() {
  const historyBefore = layoutSnapshot();
  let connectedAny = false;

  while (true) {
    let best = null;
    layout.rails.forEach((firstRail, firstRailIndex) => {
      PARTS[firstRail.part].connectors.forEach((firstConnector, firstIndex) => {
        const first = { railId: firstRail.id, connector: firstIndex };
        if (connectionFor(first.railId, first.connector)) return;
        layout.rails.slice(firstRailIndex + 1).forEach(secondRail => {
          PARTS[secondRail.part].connectors.forEach((secondConnector, secondIndex) => {
            const second = { railId: secondRail.id, connector: secondIndex };
            if (connectionFor(second.railId, second.connector)) return;
            if (firstConnector.end === secondConnector.end || !isConnectionValid(first, second)) return;

            const firstWorld = worldConnector(firstRail, firstIndex);
            const secondWorld = worldConnector(secondRail, secondIndex);
            const distance = Math.hypot(firstWorld.x - secondWorld.x, firstWorld.y - secondWorld.y);
            if (!best || distance < best.distance) {
              best = { distance, first, second };
            }
          });
        });
      });
    });

    if (!best) break;
    layout.connections.push({ from: { ...best.first }, to: { ...best.second } });
    connectedAny = true;
  }

  if (connectedAny) {
    pushHistoryIfChanged(historyBefore);
    scheduleLayoutSave();
    render();
  }
}

function findBestNearbyConnection(movingRailIds, predicate) {
  const movingIds = new Set(movingRailIds);
  let best = null;
  movingRailIds.map(railById).filter(Boolean).forEach(movingRail => {
    PARTS[movingRail.part].connectors.forEach((movingConnector, movingIndex) => {
      const moving = { railId: movingRail.id, connector: movingIndex };
      if (connectionFor(moving.railId, moving.connector)) return;
      const movingWorld = worldConnector(movingRail, movingIndex);
      layout.rails.forEach(otherRail => {
        if (movingIds.has(otherRail.id)) return;
        PARTS[otherRail.part].connectors.forEach((otherConnector, otherIndex) => {
          const anchor = { railId: otherRail.id, connector: otherIndex };
          if (connectionFor(anchor.railId, anchor.connector)) return;
          if (movingConnector.end === otherConnector.end) return;
          const otherWorld = worldConnector(otherRail, otherIndex);
          const movingDisplay = projectWorldPoint(movingWorld);
          const otherDisplay = projectWorldPoint(otherWorld);
          const distance = Math.hypot(
            movingDisplay.x - otherDisplay.x,
            movingDisplay.y - otherDisplay.y
          );
          if (!predicate(moving, anchor, movingWorld, otherWorld, distance)) return;
          if (!best || distance < best.distance) best = { distance, moving, anchor };
        });
      });
    });
  });
  return best;
}

function isWithinSnapDistance(moving, anchor, movingWorld, anchorWorld, distance) {
  return distance <= SNAP_DISTANCE;
}

// Detect nearby unconnected connectors during a drag and snap the moving rail to one.
function autoConnectDraggedRail(movingRail, pointerPoint) {
  const best = findBestNearbyConnection([movingRail.id], isWithinSnapDistance);

  if (!best) return false;
  const anchorRail = railById(best.anchor.railId);
  const previousHeight = movingRail.position[2];
  const restoreState = {
    rotation: movingRail.rotation,
    offsetX: state.drag.offsetX,
    offsetY: state.drag.offsetY
  };
  snapRailToConnector(anchorRail, best.anchor.connector, movingRail, best.moving.connector);
  detachInvalidConnections(movingRail.id);
  layout.connections.push({ from: { ...best.anchor }, to: { ...best.moving } });
  const snapConnections = connectNearbyUnconnectedConnectors([movingRail.id]);
  state.drag.snapLock = {
    anchor: { ...best.anchor },
    moving: { ...best.moving },
    connections: [{ anchor: { ...best.anchor }, moving: { ...best.moving } }, ...snapConnections],
    restoreState
  };
  state.drag.offsetX = movingRail.position[0] - pointerPoint.x;
  state.drag.offsetY = movingRail.position[1] - pointerPoint.y -
    (movingRail.position[2] - previousHeight) * HEIGHT_DISPLAY_SCALE;
  return true;
}

function applyGroupDragPosition(point) {
  const deltaX = point.x - state.drag.startPoint.x;
  const deltaY = point.y - state.drag.startPoint.y;
  state.drag.initialPositions.forEach(initial => {
    const selectedRail = railById(initial.id);
    selectedRail.position[0] = snapPosition(initial.position[0] + deltaX);
    selectedRail.position[1] = snapPosition(initial.position[1] + deltaY);
    selectedRail.rotation = initial.rotation;
  });
}

function snapSelectedRailsToConnector(anchorRail, anchorIndex, movingRail, movingIndex) {
  const anchor = worldConnector(anchorRail, anchorIndex);
  const moving = worldConnector(movingRail, movingIndex);
  let rotationDelta = normalizeAngle(anchor.direction + 180 - moving.direction);
  if (rotationDelta > 180) rotationDelta -= 360;

  const selectedRails = state.drag.selectedRailIds.map(railById).filter(Boolean);
  const center = {
    x: selectedRails.reduce((sum, rail) => sum + rail.position[0], 0) / selectedRails.length,
    y: selectedRails.reduce((sum, rail) => sum + rail.position[1], 0) / selectedRails.length
  };
  const radians = rotationDelta * Math.PI / 180;
  selectedRails.forEach(rail => {
    const dx = rail.position[0] - center.x;
    const dy = rail.position[1] - center.y;
    rail.position[0] = center.x + dx * Math.cos(radians) - dy * Math.sin(radians);
    rail.position[1] = center.y + dx * Math.sin(radians) + dy * Math.cos(radians);
    rail.rotation = normalizeAngle(rail.rotation + rotationDelta);
  });

  const afterRotation = worldConnector(movingRail, movingIndex);
  const translateX = anchor.x - afterRotation.x;
  const translateY = anchor.y - afterRotation.y;
  const translateZ = anchor.z - afterRotation.z;
  selectedRails.forEach(rail => {
    rail.position[0] += translateX;
    rail.position[1] += translateY;
    rail.position[2] += translateZ;
  });
}

function autoConnectDraggedSelection() {
  const selectedRails = state.drag.selectedRailIds.map(railById).filter(Boolean);
  const best = findBestNearbyConnection(state.drag.selectedRailIds, isWithinSnapDistance);

  if (!best) return false;
  const anchorRail = railById(best.anchor.railId);
  const movingRail = railById(best.moving.railId);
  snapSelectedRailsToConnector(anchorRail, best.anchor.connector, movingRail, best.moving.connector);
  selectedRails.forEach(rail => detachInvalidConnections(rail.id));
  layout.connections.push({ from: { ...best.anchor }, to: { ...best.moving } });
  const snapConnections = connectNearbyUnconnectedConnectors(state.drag.selectedRailIds);
  state.drag.snapLock = {
    anchor: { ...best.anchor },
    moving: { ...best.moving },
    connections: [{ anchor: { ...best.anchor }, moving: { ...best.moving } }, ...snapConnections],
    group: true
  };
  return true;
}

function curvePathPoints(pathDefinition) {
  const radius = pathDefinition.radius ?? CURVE_RADIUS;
  const angle = (pathDefinition.angle ?? 45) * Math.PI / 180;
  const side = pathDefinition.side === -1 ? -1 : 1;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const controlFactor = (4 / 3) * Math.tan(angle / 4);
  const endpoint = [radius * sin, side * radius * (1 - cos)];
  const control1 = [radius * controlFactor, 0];
  const control2 = [
    endpoint[0] - radius * controlFactor * cos,
    endpoint[1] - side * radius * controlFactor * sin
  ];
  return { endpoint, control1, control2 };
}

function sCurvePathPoints(pathDefinition) {
  const [endX, endY] = pathDefinition.endPosition;
  const handle = pathDefinition.radius !== undefined
    ? pathDefinition.radius * 4 / 3
    : endX / 3;
  if (pathDefinition.bulgeAxis === "y") {
    return {
      control1: [0, handle],
      control2: [endX, handle],
      endpoint: [endX, endY]
    };
  }
  return {
    control1: [handle, 0],
    control2: [pathDefinition.radius !== undefined ? handle : endX - handle, endY],
    endpoint: [endX, endY]
  };
}

function sCurveLocalPoints(pathDefinition) {
  const { control1, control2, endpoint } = sCurvePathPoints(pathDefinition);
  const endZ = pathDefinition.height ?? 0;
  return {
    start: [0, 0, 0],
    control1: [...control1, 0],
    control2: [...control2, endZ],
    endpoint: [...endpoint, endZ]
  };
}

function bezierSegments(pathDefinition) {
  return (pathDefinition.segments || []).map(segment => ({
    control1: [segment.control1[0], segment.control1[1], segment.control1[2] ?? 0],
    control2: [segment.control2[0], segment.control2[1], segment.control2[2] ?? 0],
    endpoint: [segment.endPosition[0], segment.endPosition[1], segment.endPosition[2] ?? 0]
  }));
}

function pathForDefinition(pathDefinition) {
  if (pathDefinition.shape === "straight") {
    const endPosition = pathDefinition.endPosition || [pathDefinition.length ?? STRAIGHT_LENGTH, 0];
    return `M 0 0 L ${endPosition[0]} ${endPosition[1]}`;
  }
  if (pathDefinition.shape === "curve") {
    const { endpoint, control1, control2 } = curvePathPoints(pathDefinition);
    return `M 0 0 C ${control1[0]} 0 ${control2[0]} ${control2[1]} ${endpoint[0]} ${endpoint[1]}`;
  }
  if (pathDefinition.shape === "s-curve") {
    const { control1, control2, endpoint } = sCurvePathPoints(pathDefinition);
    return `M 0 0 C ${control1[0]} ${control1[1]} ${control2[0]} ${control2[1]} ${endpoint[0]} ${endpoint[1]}`;
  }
  if (pathDefinition.shape === "bezier") {
    return `M 0 0 ${bezierSegments(pathDefinition).map(segment =>
      `C ${segment.control1[0]} ${segment.control1[1]} ${segment.control2[0]} ${segment.control2[1]} ${segment.endpoint[0]} ${segment.endpoint[1]}`
    ).join(" ")}`;
  }
  return "";
}

function pathForRailDefinition(pathDefinition, rail, projectHeight = true) {
  const projectLocalPoint = point => {
    const worldPoint = transformPoint(point, rail);
    return projectHeight ? projectWorldPoint(worldPoint) : worldPoint;
  };
  const formatPoint = point => `${point.x} ${point.y}`;
  const start = projectLocalPoint([0, 0, 0]);

  if (pathDefinition.shape === "straight") {
    const endPosition = pathDefinition.endPosition || [pathDefinition.length ?? STRAIGHT_LENGTH, 0];
    const end = projectLocalPoint([endPosition[0], endPosition[1], 0]);
    return `M ${formatPoint(start)} L ${formatPoint(end)}`;
  }
  if (pathDefinition.shape === "curve") {
    const { endpoint, control1, control2 } = curvePathPoints(pathDefinition);
    const control1Point = projectLocalPoint([...control1, 0]);
    const control2Point = projectLocalPoint([...control2, 0]);
    const endpointPoint = projectLocalPoint([...endpoint, 0]);
    return `M ${formatPoint(start)} C ${formatPoint(control1Point)} ${formatPoint(control2Point)} ${formatPoint(endpointPoint)}`;
  }
  if (pathDefinition.shape === "s-curve") {
    const { start: startPoint, control1, control2, endpoint } = sCurveLocalPoints(pathDefinition);
    const projectedStart = projectLocalPoint(startPoint);
    const control1Point = projectLocalPoint(control1);
    const control2Point = projectLocalPoint(control2);
    const endpointPoint = projectLocalPoint(endpoint);
    return `M ${formatPoint(projectedStart)} C ${formatPoint(control1Point)} ${formatPoint(control2Point)} ${formatPoint(endpointPoint)}`;
  }
  if (pathDefinition.shape === "bezier") {
    const segments = bezierSegments(pathDefinition);
    let d = `M ${formatPoint(start)}`;
    segments.forEach(segment => {
      const control1Point = projectLocalPoint(segment.control1);
      const control2Point = projectLocalPoint(segment.control2);
      const endpointPoint = projectLocalPoint(segment.endpoint);
      d += ` C ${formatPoint(control1Point)} ${formatPoint(control2Point)} ${formatPoint(endpointPoint)}`;
    });
    return d;
  }
  return "";
}

function pathsForPart(partId) {
  return (PARTS[partId]?.paths || []).map(pathForDefinition).filter(Boolean);
}

function pathsForRail(rail) {
  const part = PARTS[rail.part];
  const activePathIndexes = new Set(
    switchDefinitions(rail.part).map(definition => definition.states[switchStateForRail(rail, definition.id)])
  );
  return part.paths
    .map((pathDefinition, index) => ({
      d: pathForRailDefinition(pathDefinition, rail),
      shadowD: pathForRailDefinition(pathDefinition, rail, false),
      color: pathDefinition.color,
      active: activePathIndexes.has(index)
    }))
    .filter(path => path.d)
    .sort((a, b) => Number(a.active) - Number(b.active));
}

function localPathPoints(pathDefinition) {
  if (pathDefinition.shape === "straight") {
    const endPosition = pathDefinition.endPosition || [pathDefinition.length ?? STRAIGHT_LENGTH, 0];
    return [
      [0, 0, 0],
      [endPosition[0], endPosition[1], 0]
    ];
  }
  if (pathDefinition.shape === "curve") {
    const { endpoint, control1, control2 } = curvePathPoints(pathDefinition);
    return [
      [0, 0, 0],
      [...control1, 0],
      [...control2, 0],
      [...endpoint, 0]
    ];
  }
  if (pathDefinition.shape === "s-curve") {
    const { start, control1, control2, endpoint } = sCurveLocalPoints(pathDefinition);
    return [
      start,
      control1,
      control2,
      endpoint
    ];
  }
  if (pathDefinition.shape === "bezier") {
    return [
      [0, 0, 0],
      ...bezierSegments(pathDefinition).flatMap(segment => [
        segment.control1,
        segment.control2,
        segment.endpoint
      ])
    ];
  }
  return [];
}

function localPartPoints(part, instance = null) {
  if (part.type === "train") {
    const [width, height] = part.size;
    return [
      [-width / 2, -height / 2, 0],
      [width / 2, -height / 2, 0],
      [width / 2, height / 2, 0],
      [-width / 2, height / 2, 0]
    ];
  }
  if (part.type === "text") {
    const { width, height } = textMetrics(instance?.text, part);
    return [
      [-width / 2, -height / 2, 0],
      [width / 2, -height / 2, 0],
      [width / 2, height / 2, 0],
      [-width / 2, height / 2, 0]
    ];
  }
  return [
    ...(part.connectors || []).map(connector => connector.position),
    ...(part.paths || []).flatMap(localPathPoints)
  ];
}

function partIconViewBox(partId) {
  const part = PARTS[partId];
  const pathDefinition = part?.paths?.[0];
  if (part?.iconViewBox) return part.iconViewBox;
  if (part?.type === "train") {
    const [width, height] = part.size;
    return `${-width / 2 - 1} ${-height / 2 - 1} ${width + 2} ${height + 2}`;
  }
  if (part?.type === "text") return "-2 -1.5 4 3";
  if (part?.paths?.length > 1) return "-1 -2.5 12 6";
  if (pathDefinition?.shape === "bezier") return "-1 -5 18 12";
  if (pathDefinition?.shape === "s-curve") {
    const [endX, endY] = pathDefinition.endPosition;
    const padding = 0.7;
    const minX = Math.min(0, endX) - padding;
    const minY = Math.min(0, endY) - padding;
    const width = Math.abs(endX) + padding * 2;
    const height = Math.max(Math.abs(endY) + padding * 2, 2);
    return `${minX} ${minY} ${width} ${height}`;
  }
  if (pathDefinition?.shape === "straight") {
    const length = pathDefinition.length ?? STRAIGHT_LENGTH;
    const padding = Math.max(length * .1, .7);
    const width = length + padding * 2;
    const height = width / 2;
    return `${-padding} ${-height / 2} ${width} ${height}`;
  }
  return "-1 -2.5 12 6";
}

function renderPartButtons() {
  const partList = document.querySelector("#part-list");
  partList.replaceChildren();
  Object.values(PARTS).filter(part => isPlaceablePart(part.id)).forEach(part => {
    const button = document.createElement("button");
    button.className = "part-button";
    button.dataset.action = "add";
    button.dataset.part = part.id;

    const icon = document.createElement("span");
    icon.className = "part-icon";
    icon.dataset.partIcon = part.id;

    const label = document.createElement("span");
    label.className = "part-label";
    const name = document.createElement("strong");
    name.textContent = partLabel(part.id);
    label.appendChild(name);

    const usageCount = document.createElement("span");
    usageCount.className = "part-usage-count";
    usageCount.dataset.partUsageCount = part.id;
    usageCount.textContent = "0";

    button.append(icon, label, usageCount);
    partList.appendChild(button);
  });
}

function renderPartUsageCounts() {
  const counts = new Map();
  layout.rails.forEach(rail => counts.set(rail.part, (counts.get(rail.part) || 0) + 1));
  document.querySelectorAll("[data-part-usage-count]").forEach(element => {
    element.textContent = counts.get(element.dataset.partUsageCount) || 0;
  });
}

function renderPartIcons() {
  document.querySelectorAll("[data-part-icon]").forEach(element => {
    const partId = element.dataset.partIcon;
    const part = PARTS[partId];
    if (!part) return;
    const icon = createSvg("svg", {
      viewBox: partIconViewBox(partId),
      "aria-hidden": "true"
    });
    if (part.type === "train") {
      const [width, height] = part.size;
      icon.appendChild(createSvg("path", {
        class: "part-icon-train",
        d: trainBodyPath(width, height),
        fill: part.color
      }));
    }
    if (part.type === "text") {
      const label = createSvg("text", {
        class: "part-icon-text",
        x: 0,
        y: 0,
        "text-anchor": "middle",
        "dominant-baseline": "middle"
      });
      label.textContent = "T";
      icon.appendChild(label);
    }
    pathsForPart(partId).forEach((path, index) => {
      const color = part.paths?.[index]?.color;
      icon.appendChild(createSvg("path", {
        d: path,
        class: "part-icon-path",
        ...(color ? { style: `stroke: ${color}` } : {})
      }));
    });
    (part.connectors || []).forEach(connector => {
      icon.appendChild(createSvg("circle", {
        class: `part-icon-connector ${connector.end}`,
        cx: connector.position[0],
        cy: connector.position[1],
        r: .34
      }));
    });
    element.replaceChildren(icon);
  });
}

function routeAttachIndex(anchorRail, anchorIndex, partId) {
  const anchor = worldConnector(anchorRail, anchorIndex);
  return PARTS[partId].connectors.findIndex(connector => connector.end !== anchor.end);
}

function buildRouteCandidate(startRef, targetPoint, targetRef, curveCount, straightCount, halfStraightCount, quarterStraightCount, curveFlip) {
  const startRail = railById(startRef.railId);
  let anchorRail = startRail;
  let anchorIndex = startRef.connector;
  let pieceNumber = 0;
  const rails = [];
  const connections = [];
  const partIds = [
    ...Array.from({ length: curveCount }, () => "curve"),
    ...Array.from({ length: straightCount }, () => "straight"),
    ...Array.from({ length: halfStraightCount }, () => "straight-half"),
    ...Array.from({ length: quarterStraightCount }, () => "straight-quarter")
  ];

  partIds.forEach(partId => {
    const rail = {
      id: `route-preview-${pieceNumber++}`,
      part: partId,
      position: [0, 0, anchorRail.position[2]],
      rotation: 0,
      flip: partId === "curve" ? curveFlip : false
    };
    const attachIndex = routeAttachIndex(anchorRail, anchorIndex, partId);
    snapRailToConnector(anchorRail, anchorIndex, rail, attachIndex);
    const freeIndex = attachIndex === 0 ? 1 : 0;
    rails.push(rail);
    connections.push({
      from: { railId: anchorRail.id, connector: anchorIndex },
      to: { railId: rail.id, connector: attachIndex }
    });
    anchorRail = rail;
    anchorIndex = freeIndex;
  });

  const endpoint = worldConnector(anchorRail, anchorIndex);
  const target = targetRef ? worldConnector(railById(targetRef.railId), targetRef.connector) : null;
  const distance = target
    ? Math.hypot(endpoint.x - target.x, endpoint.y - target.y)
    : Math.hypot(endpoint.x - targetPoint.x, endpoint.y - targetPoint.y);
  const targetCompatible = !target || endpoint.end !== target.end;

  return {
    rails,
    connections,
    endpointRef: { railId: anchorRail.id, connector: anchorIndex },
    endpoint,
    distance,
    targetCompatible,
    score: distance + (target && !targetCompatible ? 1000 : 0)
  };
}

function routeHeadingAtEndpoint(rail, connectorIndex) {
  return worldConnector(rail, connectorIndex).direction;
}

function buildBestRoute(startRef, targetPoint, targetRef) {
  const target = targetRef
    ? worldConnector(railById(targetRef.railId), targetRef.connector)
    : targetPoint;

  let best = null;
  for (let curveCount = 0; curveCount <= ROUTE_MAX_CURVES; curveCount += 1) {
    let improved = false;
    const curveFlips = curveCount === 0 ? [false] : [false, true];
    curveFlips.forEach(curveFlip => {
      const curveOnlyRoute = buildRouteCandidate(
        startRef,
        targetPoint,
        targetRef,
        curveCount,
        0,
        0,
        0,
        curveFlip
      );
      const straightHeading = routeHeadingAtEndpoint(
        curveOnlyRoute.rails.at(-1) || railById(startRef.railId),
        curveOnlyRoute.endpointRef.connector
      );
      const headingRadians = straightHeading * Math.PI / 180;
      const forwardDistance = (
        (target.x - curveOnlyRoute.endpoint.x) * Math.cos(headingRadians) +
        (target.y - curveOnlyRoute.endpoint.y) * Math.sin(headingRadians)
      );
      let straightUnits = Math.max(
        0,
        Math.min(ROUTE_MAX_STRAIGHTS * 4 + 3, Math.round(forwardDistance / QUARTER_STRAIGHT_LENGTH))
      );
      if (curveCount === 0 && straightUnits === 0) straightUnits = 1;
      let straightCount = Math.floor(straightUnits / 4);
      const remainder = straightUnits % 4;
      const halfStraightCount = remainder >= 2 ? 1 : 0;
      const quarterStraightCount = remainder % 2;

      const candidate = buildRouteCandidate(
        startRef,
        targetPoint,
        targetRef,
        curveCount,
        straightCount,
        halfStraightCount,
        quarterStraightCount,
        curveFlip
      );
      if (!best || candidate.score < best.score - 0.0001) {
        best = candidate;
        improved = true;
      }
    });
    if (!improved && best) break;
  }
  return best;
}

function findRouteTarget(point, startRef) {
  let best = null;
  layout.rails.forEach(rail => {
    PARTS[rail.part].connectors.forEach((connector, connectorIndex) => {
      if (rail.id === startRef.railId && connectorIndex === startRef.connector) return;
      if (connectionFor(rail.id, connectorIndex)) return;
      const world = worldConnector(rail, connectorIndex);
      const display = projectWorldPoint(world);
      const distance = Math.hypot(display.x - point.x, display.y - point.y);
      if (distance <= 0.7 && (!best || distance < best.distance)) {
        best = { distance, railId: rail.id, connector: connectorIndex };
      }
    });
  });
  return best ? { railId: best.railId, connector: best.connector } : null;
}

function renderRoutePreview() {
  routePreviewLayer.replaceChildren();
  const route = state.routeDrag?.preview;
  if (!route) return;
  route.rails.forEach(rail => {
    const group = createSvg("g", {
      class: "route-preview",
      transform: `translate(${rail.position[0]} ${rail.position[1] - rail.position[2] * HEIGHT_DISPLAY_SCALE}) rotate(${rail.rotation}) scale(${rail.flip ? -1 : 1} 1)`
    });
    pathsForPart(rail.part).forEach(path => {
      group.appendChild(createSvg("path", { d: path, class: "rail-shadow" }));
      group.appendChild(createSvg("path", { d: path, class: "rail-line" }));
      group.appendChild(createSvg("path", { d: path, class: "rail-inner" }));
    });
    PARTS[rail.part].connectors.forEach(connector => {
      group.appendChild(createSvg("circle", {
        class: "route-preview-connector",
        cx: connector.position[0], cy: connector.position[1], r: .24
      }));
    });
    routePreviewLayer.appendChild(group);
  });
  if (state.routeDrag.targetRef) {
    const target = worldConnector(railById(state.routeDrag.targetRef.railId), state.routeDrag.targetRef.connector);
    const displayTarget = projectWorldPoint(target);
    routePreviewLayer.appendChild(createSvg("circle", { class: "route-preview-target", cx: displayTarget.x, cy: displayTarget.y, r: .55 }));
  }
}

function beginRouteDrag(event, railId, connectorIndex) {
  if (event.button !== 0) return;
  if (connectionFor(railId, connectorIndex)) return;
  const point = svgPoint(event);
  state.justRouteDragged = false;
  state.routeDrag = {
    startRef: { railId, connector: connectorIndex },
    startPoint: { x: point.x, y: point.y },
    moved: false,
    targetRef: null,
    preview: null
  };
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function commitRoute(routeDrag) {
  const route = routeDrag.preview;
  if (!route || (routeDrag.targetRef && !route.targetCompatible)) return false;
  const historyBefore = layoutSnapshot();
  const idMap = new Map();
  const addedRails = route.rails.map(previewRail => {
    const rail = {
      id: nextId(),
      part: previewRail.part,
      position: [...previewRail.position],
      rotation: previewRail.rotation,
      flip: previewRail.flip
    };
    idMap.set(previewRail.id, rail.id);
    layout.rails.push(rail);
    return rail;
  });
  const remap = ref => ({ railId: idMap.get(ref.railId) || ref.railId, connector: ref.connector });
  route.connections.forEach(connection => {
    layout.connections.push({ from: remap(connection.from), to: remap(connection.to) });
  });
  if (routeDrag.targetRef) {
    layout.connections.push({ from: remap(route.endpointRef), to: { ...routeDrag.targetRef } });
  }
  state.selectedRailId = addedRails.at(-1).id;
  state.selectedRailIds = addedRails.map(rail => rail.id);
  pushHistoryIfChanged(historyBefore);
  scheduleLayoutSave();
  render();
  return true;
}

function selectRail(id) {
  state.selectedRailId = id;
  state.selectedRailIds = [id];
  renderSelectionChange();
}

function toggleRailSelection(id) {
  const selected = new Set(state.selectedRailIds);
  if (!selected.size && state.selectedRailId) selected.add(state.selectedRailId);
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  state.selectedRailIds = [...selected];
  state.selectedRailId = selected.has(id) ? id : state.selectedRailIds.at(-1) || null;
  renderSelectionChange();
}

function renderSelectionChange() {
  render(!simulator.isPlaying());
  if (simulator.isPlaying()) renderInspector();
}

function connectedRailIds(startId) {
  const connected = new Set([startId]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    layout.connections.forEach(connection => {
      const fromSelected = connected.has(connection.from.railId);
      const toSelected = connected.has(connection.to.railId);
      if (fromSelected && !connected.has(connection.to.railId)) {
        connected.add(connection.to.railId);
        expanded = true;
      }
      if (toSelected && !connected.has(connection.from.railId)) {
        connected.add(connection.from.railId);
        expanded = true;
      }
    });
  }
  return [...connected];
}

function resetConnectedGroupHeight(startId) {
  const rails = connectedRailIds(startId).map(railById).filter(Boolean);
  const heights = rails.flatMap(rail =>
    (PARTS[rail.part].connectors || [])
      .map(connector => transformPoint(connector.position, rail).z)
  );
  if (!heights.length) return;
  const lowestHeight = Math.min(...heights);
  if (Math.abs(lowestHeight) < 0.0001) return;
  rails.forEach(rail => { rail.position[2] -= lowestHeight; });
}

function selectConnectedRails(id) {
  state.selectedRailId = id;
  state.selectedRailIds = connectedRailIds(id);
  renderSelectionChange();
}

function addPartInteraction(group, rail) {
  group.addEventListener("pointerdown", event => beginDrag(event, rail.id));
  group.addEventListener("click", event => {
    if (state.justRouteDragged) {
      state.justRouteDragged = false;
      return;
    }
    if (state.justDragged) {
      state.justDragged = false;
      return;
    }
    if (state.drag?.moved) return;
    if (event.ctrlKey || event.metaKey) toggleRailSelection(rail.id);
    else if (event.shiftKey) selectConnectedRails(rail.id);
    else selectRail(rail.id);
  });
}

function renderText(rail) {
  const part = PARTS[rail.part];
  const displayed = displayedPartInstance(rail);
  const metrics = textMetrics(rail.text, part);
  const group = createSvg("g", {
    class: "rail-instance text-instance",
    "data-rail-id": rail.id,
    transform: `translate(${displayed.position[0]} ${displayed.position[1] - displayed.position[2] * HEIGHT_DISPLAY_SCALE}) rotate(${displayed.rotation})`
  });
  group.appendChild(createSvg("rect", {
    class: "text-box",
    x: -metrics.width / 2,
    y: -metrics.height / 2,
    width: metrics.width,
    height: metrics.height
  }));
  const content = createSvg("text", {
    class: "text-content",
    x: 0,
    "text-anchor": "middle",
    "font-size": metrics.fontSize,
    fill: part.color
  });
  const firstLineY = -((metrics.lines.length - 1) * metrics.lineHeight) / 2;
  metrics.lines.forEach((line, index) => {
    const lineNode = createSvg("tspan", { x: 0, y: firstLineY + index * metrics.lineHeight });
    lineNode.textContent = line || " ";
    content.appendChild(lineNode);
  });
  group.appendChild(content);
  addPartInteraction(group, rail);
  railLayer.appendChild(group);
}

function trainBodyPath(width, height) {
  const left = -width / 2;
  const right = width / 2;
  const top = -height / 2;
  const bottom = height / 2;
  const frontRadius = Math.min(height * 0.46, width * 0.22);
  return [
    `M ${left} ${top}`,
    `H ${right - frontRadius}`,
    `Q ${right} ${top} ${right} ${top + frontRadius}`,
    `V ${bottom - frontRadius}`,
    `Q ${right} ${bottom} ${right - frontRadius} ${bottom}`,
    `H ${left}`,
    "Z"
  ].join(" ");
}

function renderTrain(rail) {
  const part = PARTS[rail.part];
  const [width, height] = part.size;
  const displayed = displayedPartInstance(rail);
  const group = createSvg("g", {
    class: "rail-instance train-instance",
    "data-rail-id": rail.id,
    transform: `translate(${displayed.position[0]} ${displayed.position[1] - displayed.position[2] * HEIGHT_DISPLAY_SCALE}) rotate(${displayed.rotation}) scale(${displayed.flip ? -1 : 1} 1)`
  });
  group.appendChild(createSvg("path", {
    class: "train-body",
    d: trainBodyPath(width, height),
    fill: trainColorForRail(rail)
  }));
  group.appendChild(createSvg("rect", {
    class: "train-hit",
    x: -width / 2,
    y: -height / 2,
    width,
    height,
    fill: "transparent"
  }));
  addPartInteraction(group, rail);
  railLayer.appendChild(group);
}

function renderRail(rail) {
  const part = PARTS[rail.part];
  if (part.type === "text") {
    renderText(rail);
    return;
  }
  if (part.type === "train") {
    renderTrain(rail);
    return;
  }
  const group = createSvg("g", {
    class: "rail-instance",
    "data-rail-id": rail.id
  });
  pathsForRail(rail).forEach(path => {
    if (path.shadowD !== path.d) {
      group.appendChild(createSvg("path", { d: path.shadowD, class: "rail-height-shadow" }));
    }
    group.appendChild(createSvg("path", { d: path.d, class: "rail-shadow" }));
    group.appendChild(createSvg("path", {
      d: path.d,
      class: `rail-line ${switchModeForRail(rail)}`,
      ...(path.color ? { style: `stroke: ${path.color}` } : {})
    }));
    group.appendChild(createSvg("path", { d: path.d, class: "rail-inner" }));
    group.appendChild(createSvg("path", { d: path.d, class: "rail-hit" }));
  });
  part.connectors.forEach((connector, index) => {
    const connected = Boolean(connectionFor(rail.id, index));
    const point = projectWorldPoint(worldConnector(rail, index));
    const circle = createSvg("circle", {
      class: `connector ${connector.end} ${connected ? "connected" : ""}`,
      cx: point.x, cy: point.y, r: 0.24,
      "data-rail-id": rail.id, "data-connector-index": index
    });
    circle.addEventListener("pointerdown", event => {
      event.stopPropagation();
      beginRouteDrag(event, rail.id, index);
    });
    group.appendChild(circle);
  });
  addPartInteraction(group, rail);
  railLayer.appendChild(group);
}

function renderConnections() {
  const draggingRailIds = new Set(state.drag?.selectedRailIds || []);
  layout.connections.forEach(connection => {
    const aRail = railById(connection.from.railId);
    const bRail = railById(connection.to.railId);
    if (!aRail || !bRail) return;
    if (draggingRailIds.has(aRail.id) || draggingRailIds.has(bRail.id)) return;
    const a = projectWorldPoint(worldConnector(aRail, connection.from.connector));
    const b = projectWorldPoint(worldConnector(bRail, connection.to.connector));
    connectionLayer.appendChild(createSvg("line", { class: "connection-line", x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
    connectionLayer.appendChild(createSvg("circle", { class: "connection-node", cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, r: .16 }));
  });
}

function renderSelection() {
  const selectedRails = layout.rails.filter(rail => state.selectedRailIds.includes(rail.id));
  if (!selectedRails.length) return;
  const worldPoints = selectedRails.flatMap(rail =>
    localPartPoints(PARTS[rail.part], rail)
      .map(point => projectWorldPoint(transformPoint(point, displayedPartInstance(rail))))
  );
  const padding = 0.5;
  const xs = worldPoints.map(point => point.x);
  const ys = worldPoints.map(point => point.y);
  const minX = Math.min(...xs) - padding;
  const maxX = Math.max(...xs) + padding;
  const minY = Math.min(...ys) - padding;
  const maxY = Math.max(...ys) + padding;
  selectionLayer.appendChild(createSvg("rect", {
    class: "selection-outline", x: minX, y: minY,
    width: maxX - minX, height: maxY - minY, rx: .4
  }));
}

function setSelectedSwitchState(switchId, nextState) {
  const rail = railById(state.selectedRailId);
  const definition = rail && switchDefinitions(rail.part).find(item => item.id === switchId);
  if (!definition || !Object.prototype.hasOwnProperty.call(definition.states, nextState)) return;
  if (switchStateForRail(rail, switchId) === nextState) return;
  const historyBefore = simulator.isPlaying() ? null : layoutSnapshot();
  rail.states = {
    ...switchStatesForRail(rail),
    [switchId]: nextState
  };
  if (historyBefore) pushHistoryIfChanged(historyBefore);
  if (!simulator.isPlaying()) scheduleLayoutSave();
  render();
}

function setSelectedSwitchMode(mode) {
  const rail = railById(state.selectedRailId);
  if (!rail || state.selectedRailIds.length !== 1 || !switchDefinitions(rail.part).length) return;
  if (!SWITCH_MODES.includes(mode)) return;
  if (switchModeForRail(rail) === mode) return;
  const historyBefore = layoutSnapshot();
  if (mode) rail.mode = mode;
  else delete rail.mode;
  pushHistoryIfChanged(historyBefore);
  scheduleLayoutSave();
  render();
}

function setSelectedTrainColor(color) {
  const rail = railById(state.selectedRailId);
  const option = PARTS[rail?.part]?.colors?.find(item => item.color === color);
  if (!rail || state.selectedRailIds.length !== 1 || PARTS[rail.part].type !== "train" || !option) return;
  if (trainColorForRail(rail) === option.color) return;
  const historyBefore = layoutSnapshot();
  rail.color = option.color;
  pushHistoryIfChanged(historyBefore);
  scheduleLayoutSave();
  render();
}

function setSelectedText(text) {
  const rail = railById(state.selectedRailId);
  if (!rail || state.selectedRailIds.length !== 1 || PARTS[rail.part].type !== "text") return;
  if (rail.text === text) return;
  const historyBefore = layoutSnapshot();
  rail.text = text;
  pushHistoryIfChanged(historyBefore);
  scheduleLayoutSave();
  render();
}

function switchStateLabel(stateName) {
  return stateName.charAt(0).toUpperCase() + stateName.slice(1);
}

function renderInspector() {
  const rail = railById(state.selectedRailId);
  if (!rail) {
    inspector.innerHTML = `<div class="no-selection">Select a rail to view<br />its properties</div>`;
    return;
  }
  const connections = layout.connections.filter(connection => connection.from.railId === rail.id || connection.to.railId === rail.id).length;
  const part = PARTS[rail.part];
  const definitions = switchDefinitions(rail.part);
  const switchControls = definitions.length && state.selectedRailIds.length === 1
    ? `<div class="switch-state-control">
        <label>Point State</label>
        ${definitions.map((definition, index) => {
          const currentSwitchState = switchStateForRail(rail, definition.id);
          return `<div class="switch-point-control">
            <label>Point ${index + 1}</label>
            <div class="switch-options">
              ${Object.keys(definition.states).map(stateName => `
                <button class="switch-option${stateName === currentSwitchState ? " is-active" : ""}" data-action="set-switch" data-switch-id="${definition.id}" data-switch-state="${stateName}">${switchStateLabel(stateName)}</button>
              `).join("")}
          </div>
        </div>`;
        }).join("")}
        <div class="switch-mode-control">
          <label for="switch-mode">Mode</label>
          <select id="switch-mode" data-action="set-switch-mode">
            <option value=""${switchModeForRail(rail) === "" ? " selected" : ""}>Normal</option>
            <option value="auto-switch"${switchModeForRail(rail) === "auto-switch" ? " selected" : ""}>Auto Switch</option>
            <option value="fixed"${switchModeForRail(rail) === "fixed" ? " selected" : ""}>Fixed</option>
          </select>
        </div>
      </div>`
    : "";
  const trainColorControl = part.type === "train"
    ? `<div class="train-color-control">
        <label for="train-color">Color</label>
        <select id="train-color" data-action="set-train-color">
          ${part.colors.map(option => `<option value="${option.color}"${trainColorForRail(rail) === option.color ? " selected" : ""}>${option.name.en}</option>`).join("")}
        </select>
      </div>`
    : "";
  const textControl = part.type === "text"
    ? `<div class="text-content-control">
        <label for="text-content">Text</label>
        <input id="text-content" data-action="set-text" type="text" value="${escapeHtml(rail.text || "")}" />
      </div>`
    : "";
  inspector.innerHTML = `
    <div class="property-title"><div class="property-name"><strong>${partEnglishLabel(rail.part)}</strong><small>${rail.id}</small></div></div>
    <div class="property-grid">
      <div class="property"><label>X Position</label><output>${snapPosition(rail.position[0])}</output></div>
      <div class="property"><label>Y Position</label><output>${snapPosition(rail.position[1])}</output></div>
      <div class="property"><label>Rotation</label><output>${rail.rotation}°</output></div>
      <div class="property"><label>Height (Z)</label><output>${rail.position[2]}</output></div>
    </div>
    <div class="flip-state">Flip: <strong>${rail.flip ? "ON" : "OFF"}</strong></div>
    <div class="connection-state"><span>Connections</span><strong>${connections}</strong></div>
    ${switchControls}
    ${trainColorControl}
    ${textControl}`;
}

function setSelectionMenuOpen(open) {
  selectionMenuPopup.hidden = !open;
  selectionMenuButton.setAttribute("aria-expanded", String(open));
}

function setLoadMenuOpen(open) {
  loadMenuPopup.hidden = !open;
  loadMenuButton.setAttribute("aria-expanded", String(open));
}

function renderSampleButtons() {
  if (!sampleList || !loadMenuDivider) return;
  sampleList.replaceChildren();
  SAMPLES.forEach((sample, index) => {
    const button = document.createElement("button");
    button.className = "selection-menu-item";
    button.dataset.action = "load-sample";
    button.dataset.sampleIndex = String(index);
    button.textContent = sample?.metadata?.title || `サンプル${index + 1}`;
    sampleList.append(button);
  });
  const hasSamples = SAMPLES.length > 0;
  sampleList.hidden = !hasSamples;
  loadMenuDivider.hidden = !hasSamples;
}

function render(updateInspector = true) {
  railLayer.replaceChildren();
  connectionLayer.replaceChildren();
  routePreviewLayer.replaceChildren();
  selectionLayer.replaceChildren();
  const orderedParts = [...layout.rails]
    .sort((a, b) => averageConnectorHeight(a) - averageConnectorHeight(b));
  orderedParts.filter(part => !["train", "text"].includes(PARTS[part.part]?.type)).forEach(renderRail);
  orderedParts.filter(part => PARTS[part.part]?.type === "text").forEach(renderRail);
  orderedParts.filter(part => PARTS[part.part]?.type === "train").forEach(renderRail);
  renderConnections();
  renderSelection();
  if (updateInspector) renderInspector();
  railCount.textContent = layout.rails.length;
  renderPartUsageCounts();
  const hasSelection = Boolean(state.selectedRailId && railById(state.selectedRailId));
  selectionControls.classList.toggle("is-visible", hasSelection);
  selectionControls.setAttribute("aria-hidden", String(!hasSelection));
  if (!hasSelection) setSelectionMenuOpen(false);
  emptyState.hidden = layout.rails.length > 0;
}

function setZoom(nextZoom, focusPoint = null) {
  const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, nextZoom));
  const oldViewBox = viewState.viewBox;
  const width = BASE_VIEWBOX.width / zoom;
  const height = BASE_VIEWBOX.height / zoom;
  const anchor = focusPoint || {
    x: oldViewBox.x + oldViewBox.width / 2,
    y: oldViewBox.y + oldViewBox.height / 2
  };
  const ratioX = width / oldViewBox.width;
  const ratioY = height / oldViewBox.height;

  viewState.zoom = zoom;
  viewState.viewBox = {
    x: anchor.x - (anchor.x - oldViewBox.x) * ratioX,
    y: anchor.y - (anchor.y - oldViewBox.y) * ratioY,
    width,
    height
  };
  canvas.setAttribute("viewBox", `${viewState.viewBox.x} ${viewState.viewBox.y} ${width} ${height}`);
  document.querySelector("#zoom-value").textContent = `${Math.round(zoom * 100)}%`;
}

function resetZoom() {
  setZoom(DEFAULT_ZOOM);
}

function fitLayout() {
  if (!layout.rails.length) {
    resetZoom();
    return;
  }

  const worldPoints = layout.rails.flatMap(rail => {
    const part = PARTS[rail.part];
    const localPoints = localPartPoints(part, rail);
    return localPoints.map(point => projectWorldPoint(transformPoint(point, rail)));
  });
  const padding = 2;
  let minX = Math.min(...worldPoints.map(point => point.x)) - padding;
  let maxX = Math.max(...worldPoints.map(point => point.x)) + padding;
  let minY = Math.min(...worldPoints.map(point => point.y)) - padding;
  let maxY = Math.max(...worldPoints.map(point => point.y)) + padding;
  let width = Math.max(maxX - minX, 1);
  let height = Math.max(maxY - minY, 1);
  const rect = canvas.getBoundingClientRect();
  const aspect = rect.width > 0 && rect.height > 0
    ? rect.width / rect.height
    : BASE_VIEWBOX.width / BASE_VIEWBOX.height;

  if (width / height > aspect) {
    height = width / aspect;
  } else {
    width = height * aspect;
  }

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  viewState.zoom = BASE_VIEWBOX.width / width;
  viewState.viewBox = {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height
  };
  canvas.setAttribute("viewBox", `${viewState.viewBox.x} ${viewState.viewBox.y} ${width} ${height}`);
  document.querySelector("#zoom-value").textContent = `${Math.round(viewState.zoom * 100)}%`;
}

function svgPoint(event) {
  const point = canvas.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(canvas.getScreenCTM().inverse());
}

function selectionBounds(start, end) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  };
}

function updateSelectionDrag(point) {
  const drag = state.selectionDrag;
  const bounds = selectionBounds(drag.startPoint, point);
  drag.moved = bounds.width >= 0.05 || bounds.height >= 0.05;
  drag.bounds = bounds;
  drag.box.setAttribute("x", bounds.x);
  drag.box.setAttribute("y", bounds.y);
  drag.box.setAttribute("width", bounds.width);
  drag.box.setAttribute("height", bounds.height);
}

function railsInSelection(bounds) {
  return layout.rails.filter(rail => {
    const points = localPartPoints(PARTS[rail.part], rail)
      .map(point => projectWorldPoint(transformPoint(point, displayedPartInstance(rail))));
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    return Math.min(...xs) >= bounds.x && Math.max(...xs) <= bounds.x + bounds.width &&
      Math.min(...ys) >= bounds.y && Math.max(...ys) <= bounds.y + bounds.height;
  }).map(rail => rail.id);
}

function beginPan(event) {
  if (event.button !== 0) return;
  const target = event.target;
  if (target !== canvas && !target.classList?.contains("canvas-background")) return;
  state.justPanned = false;
  state.justRangeSelected = false;
  if (event.shiftKey) {
    const point = svgPoint(event);
    const box = createSvg("rect", { class: "selection-box", x: point.x, y: point.y, width: 0, height: 0 });
    selectionLayer.appendChild(box);
    state.selectionDrag = { startPoint: point, bounds: selectionBounds(point, point), moved: false, box };
    canvas.setPointerCapture?.(event.pointerId);
    return;
  }
  state.pan = {
    startClientX: event.clientX,
    startClientY: event.clientY,
    initialViewBox: { ...viewState.viewBox },
    moved: false
  };
  canvas.classList.add("is-panning");
  canvas.setPointerCapture?.(event.pointerId);
}

function beginPaletteDrag(event) {
  if (event.button !== 0) return;
  const button = event.target.closest?.(".part-button");
  if (!button) return;
  state.justPaletteDragged = false;
  state.paletteDrag = {
    partId: button.dataset.part,
    startClientX: event.clientX,
    startClientY: event.clientY,
    moved: false
  };
  button.setPointerCapture?.(event.pointerId);
}

function createPaletteRailDrag(paletteDrag, point) {
  const historyBefore = layoutSnapshot();
  const rail = addRail(paletteDrag.partId, point);
  state.justDragged = false;
  state.drag = {
    railId: rail.id,
    selectedRailIds: [rail.id],
    startPoint: { x: point.x, y: point.y },
    initialPositions: [{ id: rail.id, position: [...rail.position], rotation: rail.rotation }],
    offsetX: rail.position[0] - point.x,
    offsetY: rail.position[1] - point.y,
    moved: true,
    snapLock: null,
    historyBefore,
    fromPalette: true
  };
}

function beginDrag(event, railId) {
  if (event.button !== 0) return;
  const rail = railById(railId);
  const point = svgPoint(event);
  const dragPoint = logicalPointAtHeight(point, rail.position[2]);
  state.justDragged = false;
  state.selectedRailId = railId;
  if (event.shiftKey) state.selectedRailIds = connectedRailIds(railId);
  else if (!state.selectedRailIds.includes(railId)) state.selectedRailIds = [railId];
  if (simulator.isPlaying()) renderInspector();
  const selectedRailIds = [...state.selectedRailIds];
  state.drag = {
    railId,
    selectedRailIds,
    startPoint: { x: point.x, y: point.y },
    initialPositions: selectedRailIds.map(id => {
      const selectedRail = railById(id);
      return { id, position: [...selectedRail.position], rotation: selectedRail.rotation };
    }),
    offsetX: rail.position[0] - dragPoint.x,
    offsetY: rail.position[1] - dragPoint.y,
    moved: false,
    snapLock: null,
    historyBefore: layoutSnapshot()
  };
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

document.addEventListener("pointermove", event => {
  if (state.paletteDrag) {
    const paletteDrag = state.paletteDrag;
    const distance = Math.hypot(
      event.clientX - paletteDrag.startClientX,
      event.clientY - paletteDrag.startClientY
    );
    if (distance < 6 && !paletteDrag.moved) return;

    paletteDrag.moved = true;
    const rect = canvas.getBoundingClientRect();
    const overCanvas = event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!overCanvas) return;
    createPaletteRailDrag(paletteDrag, svgPoint(event));
    state.paletteDrag = null;
  }

  if (state.selectionDrag) {
    updateSelectionDrag(svgPoint(event));
    return;
  }

  if (state.pan) {
    const rect = canvas.getBoundingClientRect();
    const pan = state.pan;
    const deltaX = (event.clientX - pan.startClientX) * pan.initialViewBox.width / rect.width;
    const deltaY = (event.clientY - pan.startClientY) * pan.initialViewBox.height / rect.height;
    if (Math.hypot(deltaX, deltaY) < 0.05 && !pan.moved) return;

    pan.moved = true;
    viewState.viewBox = {
      ...pan.initialViewBox,
      x: pan.initialViewBox.x - deltaX,
      y: pan.initialViewBox.y - deltaY
    };
    canvas.setAttribute(
      "viewBox",
      `${viewState.viewBox.x} ${viewState.viewBox.y} ${viewState.viewBox.width} ${viewState.viewBox.height}`
    );
    return;
  }

  if (state.routeDrag) {
    const displayPoint = svgPoint(event);
    const routeDrag = state.routeDrag;
    const distance = Math.hypot(
      displayPoint.x - routeDrag.startPoint.x,
      displayPoint.y - routeDrag.startPoint.y
    );
    if (distance < ROUTE_DRAG_THRESHOLD && !routeDrag.moved) return;

    routeDrag.moved = true;
    routeDrag.targetRef = findRouteTarget(displayPoint, routeDrag.startRef);
    const startRail = railById(routeDrag.startRef.railId);
    const startConnector = worldConnector(startRail, routeDrag.startRef.connector);
    const point = logicalPointAtHeight(displayPoint, startConnector.z);
    routeDrag.preview = buildBestRoute(
      routeDrag.startRef,
      point,
      routeDrag.targetRef
    );
    renderRoutePreview();
    return;
  }

  if (!state.drag) return;
  const rail = railById(state.drag.railId);
  if (!rail) return;
  const point = svgPoint(event);
  const dragPoint = logicalPointAtHeight(point, rail.position[2]);

  if (state.drag.selectedRailIds.length > 1) {
    applyGroupDragPosition(point);

    if (state.drag.snapLock) {
      const lock = state.drag.snapLock;
      const anchorRail = railById(lock.anchor.railId);
      const movingRail = railById(lock.moving.railId);
      const anchorConnector = worldConnector(anchorRail, lock.anchor.connector);
      const movingConnector = worldConnector(movingRail, lock.moving.connector);
      const movingDisplay = projectWorldPoint(movingConnector);
      const anchorDisplay = projectWorldPoint(anchorConnector);
      const distanceFromAnchor = Math.hypot(
        movingDisplay.x - anchorDisplay.x,
        movingDisplay.y - anchorDisplay.y
      );

      if (distanceFromAnchor <= SNAP_DISTANCE * 1.2) {
        snapSelectedRailsToConnector(anchorRail, lock.anchor.connector, movingRail, lock.moving.connector);
        state.drag.moved = true;
        render();
        return;
      }
      removeSnapConnections(lock);
      state.drag.snapLock = null;
      state.drag.moved = true;
      autoConnectDraggedSelection();
      render();
      return;
    }

    state.drag.moved = true;
    state.drag.selectedRailIds.forEach(detachInvalidConnections);
    autoConnectDraggedSelection();
    render();
    return;
  }

  if (state.drag.snapLock) {
    const lock = state.drag.snapLock;
    // Calculate the normal drag position first, then use the actual connector distance to decide whether to unlock.
    rail.position[0] = snapPosition(dragPoint.x + state.drag.offsetX);
    rail.position[1] = snapPosition(dragPoint.y + state.drag.offsetY);
    const anchorRail = railById(lock.anchor.railId);
    const anchorConnector = worldConnector(anchorRail, lock.anchor.connector);
    const movingConnector = worldConnector(rail, lock.moving.connector);
    const movingDisplay = projectWorldPoint(movingConnector);
    const anchorDisplay = projectWorldPoint(anchorConnector);
    const distanceFromAnchor = Math.hypot(
      movingDisplay.x - anchorDisplay.x,
      movingDisplay.y - anchorDisplay.y
    );

    if (distanceFromAnchor <= SNAP_DISTANCE * 1.2) {
      snapRailToConnector(anchorRail, lock.anchor.connector, rail, lock.moving.connector);
      state.drag.moved = true;
      // Keep the offset fixed at the moment of snapping.
      // Updating it on every move would prevent accumulated pointer movement from exceeding the unlock distance.
      render();
      return;
    }
    // Once the tolerance is exceeded, disconnect and resume dragging naturally from the snapped position.
    removeSnapConnections(lock);
    state.drag.snapLock = null;
    rail.rotation = lock.restoreState.rotation;
    state.drag.offsetX = lock.restoreState.offsetX;
    state.drag.offsetY = lock.restoreState.offsetY;
    rail.position[0] = snapPosition(dragPoint.x + state.drag.offsetX);
    rail.position[1] = snapPosition(dragPoint.y + state.drag.offsetY);
    state.drag.moved = true;
    autoConnectDraggedRail(rail, dragPoint);
    render();
    return;
  }

  rail.position[0] = snapPosition(dragPoint.x + state.drag.offsetX);
  rail.position[1] = snapPosition(dragPoint.y + state.drag.offsetY);
  state.drag.moved = true;
  detachInvalidConnections(rail.id);
  autoConnectDraggedRail(rail, dragPoint);
  render();
});

document.addEventListener("pointerup", () => {
  if (state.paletteDrag) {
    const paletteDrag = state.paletteDrag;
    state.paletteDrag = null;
    state.justPaletteDragged = paletteDrag.moved;
    return;
  }

  if (state.selectionDrag) {
    const drag = state.selectionDrag;
    state.selectionDrag = null;
    drag.box.remove();
    if (drag.moved) {
      state.selectedRailIds = railsInSelection(drag.bounds);
      state.selectedRailId = state.selectedRailIds.at(-1) || null;
    }
    state.justRangeSelected = true;
    renderSelectionChange();
    return;
  }

  if (state.pan) {
    state.justPanned = state.pan.moved;
    state.pan = null;
    canvas.classList.remove("is-panning");
    return;
  }

  if (state.routeDrag) {
    const routeDrag = state.routeDrag;
    const committed = routeDrag.moved && commitRoute(routeDrag);
    routePreviewLayer.replaceChildren();
    state.routeDrag = null;
    state.justRouteDragged = Boolean(routeDrag.moved);
    if (!committed) render();
    return;
  }

  if (!state.drag) return;
  const draggedIds = [...state.drag.selectedRailIds];
  const drag = state.drag;
  const fromPalette = drag.fromPalette;
  const wasMoved = drag.moved;
  state.drag = null;
  if (wasMoved) {
    if (fromPalette) state.justPaletteDragged = true;
    else state.justDragged = true;
    draggedIds.forEach(id => detachInvalidConnections(id));
    if (!fromPalette) pushHistoryIfChanged(drag.historyBefore);
    scheduleLayoutSave();
    render();
  }
});

document.addEventListener("pointercancel", () => {
  const canceledDrag = state.drag;
  state.drag = null;
  state.routeDrag = null;
  if (canceledDrag?.fromPalette) {
    layout.rails = layout.rails.filter(rail => rail.id !== canceledDrag.railId);
    layout.connections = layout.connections.filter(connection =>
      connection.from.railId !== canceledDrag.railId && connection.to.railId !== canceledDrag.railId
    );
    state.selectedRailId = null;
    state.selectedRailIds = [];
    discardLastHistoryIfSame(canceledDrag.historyBefore);
    scheduleLayoutSave();
    render();
  }
  state.paletteDrag = null;
  state.pan = null;
  state.selectionDrag?.box.remove();
  state.selectionDrag = null;
  canvas.classList.remove("is-panning");
  routePreviewLayer.replaceChildren();
});
document.addEventListener("pointerdown", beginPaletteDrag);
canvas.addEventListener("pointerdown", beginPan);
canvasWrap.addEventListener("dragover", event => {
  const types = Array.from(event.dataTransfer?.types || []);
  if (!types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = event.shiftKey ? "copy" : "move";
});
canvasWrap.addEventListener("drop", event => {
  const file = event.dataTransfer?.files?.[0];
  if (!isJsonFile(file)) return;
  event.preventDefault();
  void importDroppedLayout(file, event.shiftKey);
});
canvas.addEventListener("wheel", event => {
  event.preventDefault();
  const point = svgPoint(event);
  const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
  setZoom(viewState.zoom * factor, point);
}, { passive: false });
canvas.addEventListener("selectstart", event => event.preventDefault());
canvas.addEventListener("click", event => {
  if (state.justRangeSelected) {
    state.justRangeSelected = false;
    return;
  }
  if (state.justPanned) {
    state.justPanned = false;
    return;
  }
  if (event.target === canvas || event.target.classList.contains("canvas-background")) {
    state.selectedRailId = null;
    state.selectedRailIds = [];
    render();
  }
});

document.addEventListener("click", event => {
  if (!event.target.closest?.("#selection-menu")) setSelectionMenuOpen(false);
  if (!event.target.closest?.("#load-menu")) setLoadMenuOpen(false);
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "add") {
    if (state.justPaletteDragged) {
      state.justPaletteDragged = false;
      return;
    }
    addRail(button.dataset.part);
  }
  if (action === "delete") removeSelectedRail();
  if (action === "rotate-left") rotateSelected(-45);
  if (action === "rotate-right") rotateSelected(45);
  if (action === "flip") flipSelected();
  if (action === "set-switch") setSelectedSwitchState(button.dataset.switchId, button.dataset.switchState);
  if (action === "toggle-selection-menu") {
    setSelectionMenuOpen(selectionMenuPopup.hidden);
    return;
  }
  if (action === "connect-nearest") {
    setSelectionMenuOpen(false);
    connectAllPossible();
  }
  if (action === "zoom-in") setZoom(viewState.zoom * 1.25);
  if (action === "zoom-out") setZoom(viewState.zoom / 1.25);
  if (action === "zoom-reset") resetZoom();
  if (action === "fit-layout") fitLayout();
  if (action === "clear") clearLayout();
  if (action === "export") {
    setLoadMenuOpen(false);
    exportLayout();
    return;
  }
  if (action === "save") flushLayoutSave();
  if (action === "toggle-play") {
    if (simulator.isPlaying()) stopSimulation();
    else {
      flushLayoutSave();
      simulator.start();
    }
  }
  if (action === "toggle-load-menu") {
    setLoadMenuOpen(loadMenuPopup.hidden);
    return;
  }
  if (action === "load-empty") {
    setLoadMenuOpen(false);
    clearLayout();
    return;
  }
  if (action === "load-sample") {
    setLoadMenuOpen(false);
    const sample = SAMPLES[Number(button.dataset.sampleIndex)];
    if (!sample || !importLayoutData(sample, false)) console.error("Failed to load sample layout");
    return;
  }
  if (action === "load-file") {
    setLoadMenuOpen(false);
    layoutFileInput.value = "";
    layoutFileInput.click();
  }
});

document.addEventListener("copy", event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  const data = selectedRailClipboardData();
  if (!data) return;
  event.preventDefault();
  event.clipboardData.setData("text/plain", JSON.stringify(data, null, 2));
});

document.addEventListener("paste", event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  const data = parseRailClipboardData(event.clipboardData.getData("text/plain"));
  if (!data) return;
  event.preventDefault();
  pasteRailClipboardData(data);
});

document.addEventListener("change", event => {
  const speedControl = event.target.closest?.("[data-action='set-speed']");
  if (speedControl) {
    simulator.setSpeed(speedControl.value);
    return;
  }
  const control = event.target.closest?.("[data-action='set-switch-mode']");
  if (control) {
    setSelectedSwitchMode(control.value);
    return;
  }
  const colorControl = event.target.closest?.("[data-action='set-train-color']");
  if (colorControl) {
    setSelectedTrainColor(colorControl.value);
    return;
  }
  const textControl = event.target.closest?.("[data-action='set-text']");
  if (textControl) setSelectedText(textControl.value);
});

layoutFileInput.addEventListener("change", event => {
  const file = event.target.files?.[0];
  if (isJsonFile(file)) void importDroppedLayout(file, false);
});

document.addEventListener("keydown", event => {
  if (event.target.matches("textarea, input")) return;
  const modifier = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (modifier && key === "z") {
    event.preventDefault();
    if (event.shiftKey) redoLayout();
    else undoLayout();
    return;
  }
  if (modifier && key === "y") {
    event.preventDefault();
    redoLayout();
    return;
  }
  if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); removeSelectedRail(); }
  if (key === "r") rotateSelected(event.shiftKey ? -45 : 45);
  if (key === "f") flipSelected();
  if (event.key === "Escape") render();
});

function clearLayout() {
  if (!layout.rails.length) return;
  if (!window.confirm("現在のレイアウトをすべて消去しますか？")) return;
  const historyBefore = layoutSnapshot();
  layout.rails = [];
  layout.connections = [];
  state.selectedRailId = null;
  state.selectedRailIds = [];
  pushHistoryIfChanged(historyBefore);
  scheduleLayoutSave();
  render();
}

function exportLayout() {
  const blob = new Blob([JSON.stringify(layoutFileData(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "plarail-layout.json";
  link.click();
  URL.revokeObjectURL(url);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushLayoutSave();
});

async function initialize() {
  renderPartButtons();
  renderPartIcons();
  renderSampleButtons();
  setZoom(DEFAULT_ZOOM);
  await loadSavedLayout();
  fitLayout();
  isLoadingLayout = false;
  render();
}

initialize();
