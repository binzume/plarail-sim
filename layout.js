/* DOM-free layout geometry, validation, and connection helpers. */
(function attachLayoutHelpers(global) {
  const SUPPORTED_PART_TYPES = ["rail", "train", "text"];
  const SWITCH_MODES = ["", "auto-switch", "fixed"];

  function normalizeAngle(angle) {
    return ((angle % 360) + 360) % 360;
  }

  function angleDifference(a, b) {
    const difference = Math.abs(normalizeAngle(a) - normalizeAngle(b));
    return Math.min(difference, 360 - difference);
  }

  function transformPoint(point, rail) {
    let [x, y, z] = point;
    if (rail.flip) {
      x = -x;
      z = -z;
    }
    const radians = rail.rotation * Math.PI / 180;
    return {
      x: rail.position[0] + x * Math.cos(radians) - y * Math.sin(radians),
      y: rail.position[1] + x * Math.sin(radians) + y * Math.cos(radians),
      z: rail.position[2] + z
    };
  }

  function projectWorldPoint(point, heightDisplayScale) {
    return {
      ...point,
      y: point.y - point.z * heightDisplayScale
    };
  }

  function logicalPointAtHeight(point, z, heightDisplayScale) {
    return {
      x: point.x,
      y: point.y + z * heightDisplayScale
    };
  }

  function transformDirection(direction, rail) {
    const flipped = rail.flip ? 180 - direction : direction;
    return normalizeAngle(flipped + rail.rotation);
  }

  function worldConnector(parts, rail, connectorIndex) {
    const connector = parts[rail.part].connectors[connectorIndex];
    return {
      ...transformPoint(connector.position, rail),
      direction: transformDirection(connector.direction, rail),
      end: connector.end,
      railId: rail.id,
      connector: connectorIndex
    };
  }

  function averageConnectorHeight(parts, rail) {
    const connectors = parts[rail.part]?.connectors || [];
    if (!connectors.length) return rail.position[2];
    return connectors.reduce(
      (sum, connector, index) => sum + worldConnector(parts, rail, index).z,
      0
    ) / connectors.length;
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

  function isSupportedPart(parts, partId) {
    return SUPPORTED_PART_TYPES.includes(parts[partId]?.type);
  }

  function isValidRailData(parts, rail, knownIds = null) {
    return rail && typeof rail.id === "string" && !knownIds?.has(rail.id) &&
      isSupportedPart(parts, rail.part) && Array.isArray(rail.position) && rail.position.length >= 3 &&
      rail.position.slice(0, 3).every(Number.isFinite) && Number.isFinite(rail.rotation);
  }

  function isValidConnectionData(parts, connection, railsById) {
    if (!connection?.from || !connection?.to) return false;
    const { from, to } = connection;
    const fromRail = railsById.get(from.railId);
    const toRail = railsById.get(to.railId);
    const fromConnectors = parts[fromRail?.part]?.connectors || [];
    const toConnectors = parts[toRail?.part]?.connectors || [];
    return fromRail && toRail && from.railId !== to.railId &&
      Number.isInteger(from.connector) && Number.isInteger(to.connector) &&
      fromConnectors[from.connector] && toConnectors[to.connector];
  }

  function getSwitchDefinitions(parts, partId) {
    return parts[partId]?.switches || [];
  }

  function getSwitchDefinition(parts, rail, switchId) {
    return getSwitchDefinitions(parts, rail.part).find(item => item.id === switchId) || null;
  }

  function getSwitchState(parts, rail, switchId) {
    const definition = getSwitchDefinition(parts, rail, switchId);
    if (!definition) return null;
    const state = rail.states?.[switchId];
    return Object.prototype.hasOwnProperty.call(definition.states, state)
      ? state
      : definition.default;
  }

  function getSwitchStates(parts, rail) {
    return Object.fromEntries(
      getSwitchDefinitions(parts, rail.part).map(definition => [
        definition.id,
        getSwitchState(parts, rail, definition.id)
      ])
    );
  }

  function getSwitchMode(parts, rail) {
    const mode = SWITCH_MODES.includes(rail.mode) ? rail.mode : "";
    return getSwitchDefinitions(parts, rail.part).length > 0 ? mode : "";
  }

  function normalizeLayout(parts, schemaVersion, savedLayout, options = {}) {
    if (!savedLayout || savedLayout.schemaVersion !== schemaVersion || !Array.isArray(savedLayout.rails)) return null;
    const usedIds = new Set();
    const rails = savedLayout.rails.filter(rail => {
      if (!isValidRailData(parts, rail, usedIds)) return false;
      usedIds.add(rail.id);
      return true;
    }).map(rail => {
      const switchStates = getSwitchStates(parts, rail);
      const instanceFields = options.normalizeInstance?.(rail, parts[rail.part]) || {};
      const mode = getSwitchMode(parts, rail);
      return {
        id: rail.id,
        part: rail.part,
        position: rail.position.slice(0, 3).map(roundCoordinate),
        rotation: rail.rotation,
        flip: Boolean(rail.flip),
        ...(mode ? { mode } : {}),
        ...instanceFields,
        ...(parts[rail.part].type === "text" ? { text: typeof rail.text === "string" ? rail.text : "" } : {}),
        ...(Object.keys(switchStates).length ? { states: switchStates } : {})
      };
    });
    const railsById = new Map(rails.map(rail => [rail.id, rail]));
    const connections = Array.isArray(savedLayout.connections)
      ? savedLayout.connections
        .filter(connection => isValidConnectionData(parts, connection, railsById))
        .map(connection => cloneConnection(connection))
      : [];
    const metadata = savedLayout.metadata && typeof savedLayout.metadata === "object"
      ? savedLayout.metadata
      : {};
    return {
      schemaVersion,
      metadata: {
        title: typeof metadata.title === "string" ? metadata.title : "",
        updatedAt: typeof metadata.updatedAt === "string" ? metadata.updatedAt : null
      },
      rails,
      connections
    };
  }

  function connectionFor(layout, railId, connectorIndex) {
    return layout.connections.find(connection =>
      (connection.from.railId === railId && connection.from.connector === connectorIndex) ||
      (connection.to.railId === railId && connection.to.connector === connectorIndex)
    );
  }

  function isWithinSnapLimits(aConnector, bConnector, snapDistance, angleTolerance) {
    const distance = Math.hypot(aConnector.x - bConnector.x, aConnector.y - bConnector.y);
    return distance <= snapDistance &&
      Math.abs(aConnector.z - bConnector.z) <= 1 &&
      angleDifference(aConnector.direction, bConnector.direction + 180) <= angleTolerance;
  }

  function isConnectionValid(parts, layout, aRef, bRef, snapDistance, angleTolerance, checkEnd = true) {
    const a = layout.rails.find(rail => rail.id === aRef.railId);
    const b = layout.rails.find(rail => rail.id === bRef.railId);
    if (!a || !b || a.id === b.id) return false;
    const aConnector = worldConnector(parts, a, aRef.connector);
    const bConnector = worldConnector(parts, b, bRef.connector);
    return isWithinSnapLimits(aConnector, bConnector, snapDistance, angleTolerance) &&
      (!checkEnd || aConnector.end !== bConnector.end);
  }

  function snapRailToConnector(parts, anchorRail, anchorIndex, movingRail, movingIndex) {
    const anchor = worldConnector(parts, anchorRail, anchorIndex);
    const movingBaseDirection = transformDirection(
      parts[movingRail.part].connectors[movingIndex].direction,
      movingRail
    );
    const desiredDirection = normalizeAngle(anchor.direction + 180);
    let rotationDelta = normalizeAngle(desiredDirection - movingBaseDirection);
    if (rotationDelta > 180) rotationDelta -= 360;
    movingRail.rotation = normalizeAngle(movingRail.rotation + rotationDelta);
    const afterRotation = worldConnector(parts, movingRail, movingIndex);
    movingRail.position[0] += anchor.x - afterRotation.x;
    movingRail.position[1] += anchor.y - afterRotation.y;
    movingRail.position[2] = anchor.z - (afterRotation.z - movingRail.position[2]);
  }

  function alignConnectedRails(parts, layout, rootRailId) {
    const root = layout.rails.find(rail => rail.id === rootRailId);
    if (!root) return false;

    const fixedRailIds = new Set([root.id]);
    const pendingFrames = [{
      railId: root.id,
      connections: layout.connections.filter(connection =>
        connection.from.railId === root.id || connection.to.railId === root.id
      ),
      index: 0
    }];
    let aligned = false;

    while (pendingFrames.length) {
      const frame = pendingFrames.at(-1);
      if (frame.index >= frame.connections.length) {
        pendingFrames.pop();
        continue;
      }

      const connection = frame.connections[frame.index++];
      const currentRailId = frame.railId;
      const currentRail = layout.rails.find(rail => rail.id === currentRailId);
      if (!currentRail) continue;

      const currentRef = connection.from.railId === currentRailId
        ? connection.from
        : connection.to;
      const neighborRef = connection.from.railId === currentRailId
        ? connection.to
        : connection.from;
      const neighborRail = layout.rails.find(rail => rail.id === neighborRef.railId);
      if (!neighborRail || fixedRailIds.has(neighborRail.id)) continue;

      snapRailToConnector(
        parts,
        currentRail,
        currentRef.connector,
        neighborRail,
        neighborRef.connector
      );
      aligned = true;
      fixedRailIds.add(neighborRail.id);
      pendingFrames.push({
        railId: neighborRail.id,
        connections: layout.connections.filter(item =>
          item.from.railId === neighborRail.id || item.to.railId === neighborRail.id
        ),
        index: 0
      });
    }

    return aligned;
  }

  function connectorRefsEqual(a, b) {
    return a && b && a.railId === b.railId && a.connector === b.connector;
  }

  function removeConnectionBetween(layout, first, second) {
    const connectionCount = layout.connections.length;
    layout.connections = layout.connections.filter(connection => {
      const sameDirection = connectorRefsEqual(connection.from, first) && connectorRefsEqual(connection.to, second);
      const reverseDirection = connectorRefsEqual(connection.from, second) && connectorRefsEqual(connection.to, first);
      return !sameDirection && !reverseDirection;
    });
    return layout.connections.length !== connectionCount;
  }

  const api = {
    normalizeAngle,
    SUPPORTED_PART_TYPES,
    angleDifference,
    transformPoint,
    projectWorldPoint,
    logicalPointAtHeight,
    transformDirection,
    worldConnector,
    averageConnectorHeight,
    cloneConnection,
    roundCoordinate,
    isSupportedPart,
    isValidRailData,
    isValidConnectionData,
    normalizeLayout,
    getSwitchDefinitions,
    getSwitchDefinition,
    getSwitchState,
    getSwitchStates,
    getSwitchMode,
    connectionFor,
    isWithinSnapLimits,
    isConnectionValid,
    snapRailToConnector,
    alignConnectedRails,
    connectorRefsEqual,
    removeConnectionBetween
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.Layout = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
