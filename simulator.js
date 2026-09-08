/* Layout simulation engine. The editor provides the model and consumes frames. */
(function attachLayoutSimulator(global) {
  const ATTACH_DISTANCE = 2.5;
  const PATH_SAMPLES = 24;
  const SPEED = 6;
  const SPEED_MULTIPLIERS = [1, 2, 4, 8, 16];
  const TRAIN_SPEED_MIN = 0.4;
  const TRAIN_SPEED_MAX = 2.0;
  const EPSILON = 0.0001;

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function normalizeAngle(angle) {
    return ((angle % 360) + 360) % 360;
  }

  function switchMode(rail) {
    return rail.mode || "";
  }

  function transformPoint(point, rail, part) {
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

  function cubicPoint(a, b, c, d, t) {
    const inverse = 1 - t;
    return {
      x: inverse ** 3 * a[0] + 3 * inverse ** 2 * t * b[0] + 3 * inverse * t ** 2 * c[0] + t ** 3 * d[0],
      y: inverse ** 3 * a[1] + 3 * inverse ** 2 * t * b[1] + 3 * inverse * t ** 2 * c[1] + t ** 3 * d[1],
      z: inverse ** 3 * a[2] + 3 * inverse ** 2 * t * b[2] + 3 * inverse * t ** 2 * c[2] + t ** 3 * d[2]
    };
  }

  function curvePathPoints(pathDefinition) {
    const radius = pathDefinition.radius ?? 10;
    const angle = (pathDefinition.angle ?? 45) * Math.PI / 180;
    const side = pathDefinition.side === -1 ? -1 : 1;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const controlFactor = (4 / 3) * Math.tan(angle / 4);
    const endpoint = [radius * sin, side * radius * (1 - cos), 0];
    const control1 = [radius * controlFactor, 0, 0];
    const control2 = [
      endpoint[0] - radius * controlFactor * cos,
      endpoint[1] - side * radius * controlFactor * sin,
      0
    ];
    return { start: [0, 0, 0], control1, control2, endpoint };
  }

  function pathConnectorPosition(pathDefinition, part, key) {
    const connector = part?.connectors?.[pathDefinition[key]];
    return connector ? [...connector.position] : null;
  }

  function pathStartPosition(pathDefinition, part) {
    return pathConnectorPosition(pathDefinition, part, "from") || [0, 0, 0];
  }

  function pathEndPosition(pathDefinition, part) {
    const connectorPosition = pathConnectorPosition(pathDefinition, part, "to");
    if (connectorPosition) return connectorPosition;
    const endPosition = pathDefinition.endPosition || [pathDefinition.length ?? 10, 0];
    return [endPosition[0], endPosition[1], 0];
  }

  function pathCurveRotation(pathDefinition, part) {
    if (Number.isFinite(pathDefinition.rotation)) return pathDefinition.rotation;
    const connector = part?.connectors?.[pathDefinition.from];
    return connector ? 180 - connector.direction : 0;
  }

  function rotatePathPoint(point, origin, rotation) {
    const radians = rotation * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return [
      origin[0] + point[0] * cos - point[1] * sin,
      origin[1] + point[0] * sin + point[1] * cos,
      origin[2] + (point[2] ?? 0)
    ];
  }

  function curvePathLocalPoints(pathDefinition, part) {
    const start = pathStartPosition(pathDefinition, part);
    const rotation = pathCurveRotation(pathDefinition, part);
    const curve = curvePathPoints(pathDefinition);
    return {
      start,
      control1: rotatePathPoint([...curve.control1, 0], start, rotation),
      control2: rotatePathPoint([...curve.control2, 0], start, rotation),
      endpoint: rotatePathPoint([...curve.endpoint, 0], start, rotation)
    };
  }

  function bezierSegments(pathDefinition, part = null) {
    const segments = pathDefinition.segments || [];
    let start = pathStartPosition(pathDefinition, part);
    return segments.map((segment, index) => {
      const endpoint = segment.endPosition
        ? [segment.endPosition[0], segment.endPosition[1], segment.endPosition[2] ?? 0]
        : index === segments.length - 1
          ? pathEndPosition(pathDefinition, part)
          : null;
      if (!endpoint) return null;
      const result = {
        control1: [segment.control1[0], segment.control1[1], segment.control1[2] ?? start[2]],
        control2: [segment.control2[0], segment.control2[1], segment.control2[2] ?? endpoint[2]],
        endpoint
      };
      start = endpoint;
      return result;
    }).filter(Boolean);
  }

  function localCubicSegments(pathDefinition, part) {
    if (pathDefinition.shape === "straight") {
      const start = pathStartPosition(pathDefinition, part);
      const endpoint = pathEndPosition(pathDefinition, part);
      return [{
        start,
        control1: [
          start[0] + (endpoint[0] - start[0]) / 3,
          start[1] + (endpoint[1] - start[1]) / 3,
          start[2] + (endpoint[2] - start[2]) / 3
        ],
        control2: [
          start[0] + (endpoint[0] - start[0]) * 2 / 3,
          start[1] + (endpoint[1] - start[1]) * 2 / 3,
          start[2] + (endpoint[2] - start[2]) * 2 / 3
        ],
        endpoint
      }];
    }
    if (pathDefinition.shape === "curve") {
      const { start, control1, control2, endpoint } = curvePathLocalPoints(pathDefinition, part);
      return [{ start, control1, control2, endpoint }];
    }
    if (pathDefinition.shape === "bezier") {
      const segments = bezierSegments(pathDefinition, part);
      let start = pathStartPosition(pathDefinition, part);
      return segments.map(segment => {
        const result = { start, ...segment };
        start = segment.endpoint;
        return result;
      });
    }
    return [];
  }

  function samplePath(pathDefinition, rail, part) {
    const points = [];
    localCubicSegments(pathDefinition, part).forEach(segment => {
      for (let index = 0; index <= PATH_SAMPLES; index += 1) {
        if (points.length && index === 0) continue;
        const t = index / PATH_SAMPLES;
        points.push(transformPoint(
          Object.values(cubicPoint(segment.start, segment.control1, segment.control2, segment.endpoint, t)),
          rail,
          part
        ));
      }
    });
    const cumulative = [0];
    for (let index = 1; index < points.length; index += 1) {
      cumulative.push(cumulative[index - 1] + distance(points[index - 1], points[index]));
    }
    return { points, cumulative, length: cumulative.at(-1) || 0 };
  }

  function pointAt(path, requestedDistance) {
    if (!path.points.length) return { x: 0, y: 0, z: 0, tangent: { x: 1, y: 0 } };
    const target = Math.max(0, Math.min(path.length, requestedDistance));
    let index = 1;
    while (index < path.cumulative.length && path.cumulative[index] < target) index += 1;
    const startIndex = Math.max(0, index - 1);
    const endIndex = Math.min(path.points.length - 1, index);
    const start = path.points[startIndex];
    const end = path.points[endIndex];
    const segmentLength = path.cumulative[endIndex] - path.cumulative[startIndex];
    const ratio = segmentLength > EPSILON
      ? (target - path.cumulative[startIndex]) / segmentLength
      : 0;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const tangentLength = Math.hypot(dx, dy) || 1;
    return {
      x: start.x + (end.x - start.x) * ratio,
      y: start.y + (end.y - start.y) * ratio,
      z: start.z + (end.z - start.z) * ratio,
      tangent: { x: dx / tangentLength, y: dy / tangentLength }
    };
  }

  function connectorKey(ref) {
    return `${ref.railId}:${ref.connector}`;
  }

  function createSimulator(options) {
    let playing = false;
    let animationFrame = null;
    let lastTimestamp = 0;
    let elapsedTime = 0;
    let speedMultiplier = SPEED_MULTIPLIERS[0];
    let revision = 0;
    let trainStates = [];
    let initialSwitches = [];

    function layout() {
      return options.getLayout();
    }

    function parts() {
      return options.getParts();
    }

    function railById(id) {
      return layout().rails.find(rail => rail.id === id);
    }

    function connectorWorld(rail, index) {
      const connector = parts()[rail.part].connectors[index];
      const direction = rail.flip ? 180 - connector.direction : connector.direction;
      return {
        ...transformPoint(connector.position, rail, parts()[rail.part]),
        direction: normalizeAngle(direction + rail.rotation)
      };
    }

    function pathRecords(rail) {
      const part = parts()[rail.part];
      return (part.paths || []).map((definition, index) => ({
        index,
        from: definition.from,
        to: definition.to,
        ...samplePath(definition, rail, part)
      }));
    }

    function activePathIndexes(rail) {
      const definitions = parts()[rail.part].switches || [];
      if (!definitions.length) return null;
      return new Set(definitions.map(definition => {
        const state = Object.prototype.hasOwnProperty.call(definition.states, rail.states?.[definition.id])
          ? rail.states[definition.id]
          : definition.default;
        return definition.states[state];
      }));
    }

    function isPathActive(rail, pathIndex) {
      const active = activePathIndexes(rail);
      return !active || active.has(pathIndex);
    }

    function activatePath(rail, pathIndex) {
      const definitions = parts()[rail.part].switches || [];
      const states = { ...(rail.states || {}) };
      let changed = false;
      definitions.forEach(definition => {
        const stateEntry = Object.entries(definition.states)
          .find(([, mappedPathIndex]) => mappedPathIndex === pathIndex);
        if (!stateEntry || states[definition.id] === stateEntry[0]) return;
        states[definition.id] = stateEntry[0];
        changed = true;
      });
      if (changed) {
        rail.states = states;
        revision += 1;
      }
      return changed;
    }

    function togglePath(rail, pathIndex) {
      const definitions = parts()[rail.part].switches || [];
      const states = { ...(rail.states || {}) };
      let changed = false;
      definitions.forEach(definition => {
        const controlsPath = Object.values(definition.states).includes(pathIndex);
        if (!controlsPath) return;
        const stateNames = Object.keys(definition.states);
        const currentState = Object.prototype.hasOwnProperty.call(definition.states, states[definition.id])
          ? states[definition.id]
          : definition.default;
        const currentIndex = stateNames.indexOf(currentState);
        const nextState = stateNames[(currentIndex + 1) % stateNames.length];
        if (nextState && nextState !== currentState) {
          states[definition.id] = nextState;
          changed = true;
        }
      });
      if (changed) {
        rail.states = states;
        revision += 1;
      }
      return changed;
    }

    function connectionMap() {
      const map = new Map();
      layout().connections.forEach(connection => {
        map.set(connectorKey(connection.from), connection.to);
        map.set(connectorKey(connection.to), connection.from);
      });
      return map;
    }

    function nearestPoint(path, target) {
      let best = null;
      for (let index = 1; index < path.points.length; index += 1) {
        const start = path.points[index - 1];
        const end = path.points[index];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const segmentLengthSquared = dx * dx + dy * dy;
        const ratio = segmentLengthSquared > EPSILON
          ? Math.max(0, Math.min(1, ((target.x - start.x) * dx + (target.y - start.y) * dy) / segmentLengthSquared))
          : 0;
        const point = {
          x: start.x + dx * ratio,
          y: start.y + dy * ratio
        };
        const candidate = {
          distance: Math.hypot(target.x - point.x, target.y - point.y),
          along: path.cumulative[index - 1] + Math.sqrt(segmentLengthSquared) * ratio,
          tangent: { x: dx, y: dy }
        };
        if (!best || candidate.distance < best.distance) best = candidate;
      }
      return best;
    }

    function trainForward(train) {
      const radians = (train.rotation + (train.flip ? 180 : 0)) * Math.PI / 180;
      return { x: Math.cos(radians), y: Math.sin(radians) };
    }

    function createTrainState(train) {
      const forward = trainForward(train);
      let best = null;
      layout().rails.forEach(rail => {
        const part = parts()[rail.part];
        if (part.type !== "rail") return;
        pathRecords(rail).forEach(path => {
          if (!isPathActive(rail, path.index)) return;
          const nearest = nearestPoint(path, { x: train.position[0], y: train.position[1] });
          if (!nearest) return;
          const tangentLength = Math.hypot(nearest.tangent.x, nearest.tangent.y) || 1;
          const dot = (nearest.tangent.x * forward.x + nearest.tangent.y * forward.y) / tangentLength;
          const score = nearest.distance + (1 - Math.abs(dot)) * 0.2;
          if (!best || score < best.score) {
            best = { rail, path, nearest, dot, score };
          }
        });
      });

      if (!best || best.nearest.distance > ATTACH_DISTANCE) {
        return {
          id: train.id,
          railId: null,
          pathIndex: null,
          distanceAlong: 0,
          direction: 1,
          position: [...train.position],
          rotation: train.rotation,
          flip: Boolean(train.flip),
          status: "stopped"
        };
      }

      const direction = best.dot >= 0 ? 1 : -1;
      const state = {
        id: train.id,
        railId: best.rail.id,
        pathIndex: best.path.index,
        distanceAlong: best.nearest.along,
        direction,
        autoSwitchAfterPass: Boolean(switchMode(best.rail) === "auto-switch" && direction > 0),
        position: [...train.position],
        rotation: train.rotation,
        flip: Boolean(train.flip),
        status: "running"
      };
      updateTrainVisual(state);
      return state;
    }

    function updateTrainVisual(state) {
      if (!state.railId) return;
      const rail = railById(state.railId);
      if (!rail) {
        state.status = "stopped";
        return;
      }
      const path = pathRecords(rail).find(item => item.index === state.pathIndex);
      if (!path) {
        state.status = "stopped";
        return;
      }
      const sample = pointAt(path, state.distanceAlong);
      const tangent = state.direction > 0
        ? sample.tangent
        : { x: -sample.tangent.x, y: -sample.tangent.y };
      state.position = [sample.x, sample.y, sample.z];
      state.rotation = normalizeAngle(Math.atan2(tangent.y, tangent.x) * 180 / Math.PI);
    }

    function transitionToNextPath(state) {
      const rail = railById(state.railId);
      if (!rail) {
        state.status = "stopped";
        return false;
      }
      const currentPath = pathRecords(rail).find(path => path.index === state.pathIndex);
      if (!currentPath) {
        state.status = "stopped";
        return false;
      }
      const exitIndex = state.direction > 0 ? currentPath.to : currentPath.from;
      const nextRef = connectionMap().get(connectorKey({ railId: rail.id, connector: exitIndex }));
      if (!nextRef) {
        state.status = "stopped";
        updateTrainVisual(state);
        return false;
      }

      const nextRail = railById(nextRef.railId);
      if (!nextRail || parts()[nextRail.part].type !== "rail") {
        state.status = "stopped";
        return false;
      }
      const nextPaths = pathRecords(nextRail);
      const incomingBranchPath = nextPaths.find(path =>
        path.to === nextRef.connector && !isPathActive(nextRail, path.index)
      );
      if (incomingBranchPath && switchMode(nextRail) === "") activatePath(nextRail, incomingBranchPath.index);
      const nextPath = nextPaths.find(path =>
        ((switchMode(nextRail) !== "" && path.to === nextRef.connector) || isPathActive(nextRail, path.index)) &&
        (path.from === nextRef.connector || path.to === nextRef.connector)
      );
      if (!nextPath) {
        state.status = "stopped";
        updateTrainVisual(state);
        return false;
      }

      state.railId = nextRail.id;
      state.pathIndex = nextPath.index;
      state.direction = nextPath.from === nextRef.connector ? 1 : -1;
      state.distanceAlong = state.direction > 0 ? 0 : nextPath.length;
      state.autoSwitchAfterPass = Boolean(
        switchMode(nextRail) === "auto-switch" && nextPath.from === nextRef.connector
      );
      return true;
    }

    function advanceTrain(state, amount) {
      let remaining = amount;
      while (state.status === "running" && remaining > EPSILON) {
        const rail = railById(state.railId);
        const path = rail && pathRecords(rail).find(item => item.index === state.pathIndex);
        if (!path) {
          state.status = "stopped";
          break;
        }
        const available = state.direction > 0
          ? path.length - state.distanceAlong
          : state.distanceAlong;
        if (remaining < available || available < EPSILON) {
          state.distanceAlong += state.direction * remaining;
          remaining = 0;
          updateTrainVisual(state);
          continue;
        }
        state.distanceAlong = state.direction > 0 ? path.length : 0;
        updateTrainVisual(state);
        remaining -= Math.max(available, 0);
        if (state.autoSwitchAfterPass) {
          togglePath(rail, path.index);
          state.autoSwitchAfterPass = false;
        }
        if (!transitionToNextPath(state)) break;
        updateTrainVisual(state);
      }
    }

    function trainSpeedMultiplier(state) {
      const train = railById(state.id);
      const speed = Number(train?.speed);
      if (!Number.isFinite(speed)) return 1;
      return Math.min(TRAIN_SPEED_MAX, Math.max(TRAIN_SPEED_MIN, speed));
    }

    function trainCollisionLength(state) {
      const train = railById(state.id);
      return parts()[train?.part]?.size?.[0] || 0;
    }

    function detectTrainCollisions() {
      for (let firstIndex = 0; firstIndex < trainStates.length; firstIndex += 1) {
        const first = trainStates[firstIndex];
        if (!first.railId || first.pathIndex === null) continue;
        for (let secondIndex = firstIndex + 1; secondIndex < trainStates.length; secondIndex += 1) {
          const second = trainStates[secondIndex];
          if (first.railId !== second.railId || first.pathIndex !== second.pathIndex) continue;
          const collisionDistance = (trainCollisionLength(first) + trainCollisionLength(second)) / 2;
          if (Math.abs(first.distanceAlong - second.distanceAlong) <= collisionDistance) {
            first.status = "stopped";
            second.status = "stopped";
          }
        }
      }
    }

    function frame() {
      return {
        elapsed: elapsedTime,
        speed: speedMultiplier,
        revision,
        trains: Object.fromEntries(trainStates.map(state => [state.id, {
          position: [...state.position],
          rotation: state.rotation,
          flip: state.flip,
          status: state.status
        }]))
      };
    }

    function emitFrame() {
      options.onFrame?.(frame());
    }

    function tick(timestamp) {
      if (!playing) return;
      const elapsed = Math.min(Math.max(0, timestamp - lastTimestamp) / 1000, 0.1);
      lastTimestamp = timestamp;
      elapsedTime += elapsed * speedMultiplier;
      trainStates.forEach(state => advanceTrain(
        state,
        SPEED * elapsed * speedMultiplier * trainSpeedMultiplier(state)
      ));
      detectTrainCollisions();
      emitFrame();
      animationFrame = global.requestAnimationFrame(tick);
    }

    function start() {
      if (playing) return false;
      elapsedTime = 0;
      const currentLayout = layout();
      initialSwitches = currentLayout.rails
        .filter(rail => (parts()[rail.part]?.switches || []).length)
        .map(rail => ({
          id: rail.id,
          hadStates: Object.prototype.hasOwnProperty.call(rail, "states"),
          states: { ...(rail.states || {}) }
        }));
      trainStates = currentLayout.rails
        .filter(rail => parts()[rail.part]?.type === "train")
        .map(createTrainState);
      detectTrainCollisions();
      playing = true;
      options.onStateChange?.(true);
      emitFrame();
      lastTimestamp = global.performance.now();
      animationFrame = global.requestAnimationFrame(tick);
      return true;
    }

    function stop() {
      if (!playing) return [];
      playing = false;
      if (animationFrame !== null) global.cancelAnimationFrame(animationFrame);
      animationFrame = null;
      trainStates = [];
      options.onFrame?.(null);
      options.onStateChange?.(false);
      const snapshot = initialSwitches;
      initialSwitches = [];
      return snapshot;
    }

    function setSpeed(multiplier) {
      const nextSpeed = Number(multiplier);
      if (!playing || !SPEED_MULTIPLIERS.includes(nextSpeed)) return speedMultiplier;
      speedMultiplier = nextSpeed;
      emitFrame();
      return speedMultiplier;
    }

    return {
      start,
      stop,
      setSpeed,
      isPlaying: () => playing
    };
  }

  global.createLayoutSimulator = createSimulator;
})(window);
