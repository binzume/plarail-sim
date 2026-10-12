#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

require(path.join(__dirname, "..", "parts.js"));
const Layout = require(path.join(__dirname, "..", "layout.js"));
const PARTS = globalThis.PARTS;

const MM_PER_UNIT = 216 / 10;
const SNAP_DISTANCE = 24 / MM_PER_UNIT;
const ANGLE_TOLERANCE = 22.5;
const PATH_LENGTH_SAMPLES = 24;

function usage() {
  console.error(`Usage: node cmds/stat.js <layout.json>`);
}

function readLayout(fileName) {
  const filePath = path.resolve(process.cwd(), fileName);
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const layout = Layout.normalizeLayout(PARTS, 1, data);
  if (!layout) throw new Error(`Invalid layout: ${fileName}`);
  return layout;
}

function connectorKey(railId, connectorIndex) {
  return `${railId}:${connectorIndex}`;
}

function pointFromConnector(part, connectorIndex) {
  const connector = part.connectors?.[connectorIndex];
  return connector ? [...connector.position] : [0, 0, 0];
}

function pathEndPosition(path, part) {
  const connector = part.connectors?.[path.to];
  if (connector) return [...connector.position];
  const endPosition = path.endPosition || [path.length ?? 10, 0];
  return [endPosition[0], endPosition[1], endPosition[2] ?? 0];
}

function pointDistance(a, b) {
  return Math.hypot(
    a[0] - b[0],
    a[1] - b[1],
    a[2] - b[2]
  );
}

function cubicPoint(start, control1, control2, end, t) {
  const inverse = 1 - t;
  return [
    inverse ** 3 * start[0] + 3 * inverse ** 2 * t * control1[0] +
      3 * inverse * t ** 2 * control2[0] + t ** 3 * end[0],
    inverse ** 3 * start[1] + 3 * inverse ** 2 * t * control1[1] +
      3 * inverse * t ** 2 * control2[1] + t ** 3 * end[1],
    inverse ** 3 * start[2] + 3 * inverse ** 2 * t * control1[2] +
      3 * inverse * t ** 2 * control2[2] + t ** 3 * end[2]
  ];
}

function cubicLength(start, control1, control2, end) {
  let length = 0;
  let previous = start;
  for (let index = 1; index <= PATH_LENGTH_SAMPLES; index += 1) {
    const point = cubicPoint(start, control1, control2, end, index / PATH_LENGTH_SAMPLES);
    length += pointDistance(previous, point);
    previous = point;
  }
  return length;
}

function pathLength(path, part) {
  if (Number.isFinite(path.length)) return path.length;

  if (path.shape === "curve") {
    return Math.abs(path.radius ?? 10) * Math.abs(path.angle ?? 45) * Math.PI / 180;
  }

  if (path.shape !== "bezier") {
    return pointDistance(pointFromConnector(part, path.from), pathEndPosition(path, part));
  }

  let length = 0;
  let start = pointFromConnector(part, path.from);
  (path.segments || []).forEach((segment, index, segments) => {
    const end = segment.endPosition
      ? [segment.endPosition[0], segment.endPosition[1], segment.endPosition[2] ?? 0]
      : index === segments.length - 1
        ? pathEndPosition(path, part)
        : null;
    if (!end) return;
    const control1 = [segment.control1[0], segment.control1[1], segment.control1[2] ?? start[2]];
    const control2 = [segment.control2[0], segment.control2[1], segment.control2[2] ?? end[2]];
    length += cubicLength(start, control1, control2, end);
    start = end;
  });
  return length;
}

function totalPathLength(rails) {
  return rails.reduce((total, rail) => {
    const part = PARTS[rail.part];
    return total + (part.paths || []).reduce((length, path) => length + pathLength(path, part), 0);
  }, 0);
}

function collectStats(layout) {
  const rails = layout.rails.filter(rail => PARTS[rail.part]?.type === "rail");
  const trains = layout.rails.filter(rail => PARTS[rail.part]?.type === "train");
  const connectedConnectors = new Set(
    layout.connections.flatMap(connection => [
      connectorKey(connection.from.railId, connection.from.connector),
      connectorKey(connection.to.railId, connection.to.connector)
    ])
  );
  const unconnectedConnectors = rails.reduce((count, rail) => count +
    (PARTS[rail.part].connectors || []).filter((_, index) =>
      !connectedConnectors.has(connectorKey(rail.id, index))
    ).length, 0);
  const invalidConnections = layout.connections.filter(connection =>
    !Layout.isConnectionValid(
      PARTS,
      layout,
      connection.from,
      connection.to,
      SNAP_DISTANCE,
      ANGLE_TOLERANCE
    )
  ).length;

  const points = [];
  layout.rails.forEach(rail => {
    points.push({ x: rail.position[0], y: rail.position[1], z: rail.position[2] });
    const part = PARTS[rail.part];
    (part.connectors || []).forEach((_, index) => {
      points.push(Layout.worldConnector(PARTS, rail, index));
    });
    if (part.type === "train") {
      const [width, height] = part.size;
      [-1, 1].forEach(xSign => [-1, 1].forEach(ySign => {
        points.push(Layout.transformPoint([
          xSign * width / 2,
          ySign * height / 2,
          0
        ], rail));
      }));
    }
  });

  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  points.forEach(point => {
    min.x = Math.min(min.x, point.x);
    min.y = Math.min(min.y, point.y);
    min.z = Math.min(min.z, point.z);
    max.x = Math.max(max.x, point.x);
    max.y = Math.max(max.y, point.y);
    max.z = Math.max(max.z, point.z);
  });

  const size = points.length
    ? { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z }
    : { x: 0, y: 0, z: 0 };
  return {
    rails: rails.length,
    trains: trains.length,
    unconnectedConnectors,
    invalidConnections,
    size,
    pathLength: totalPathLength(rails)
  };
}

function format(value) {
  return Number(value.toFixed(3));
}

function formatMeters(value) {
  return `${(value * MM_PER_UNIT / 1000).toFixed(1)} m`;
}

function main() {
  const fileName = process.argv[2];
  if (!fileName) {
    usage();
    process.exitCode = 1;
    return;
  }
  try {
    const stats = collectStats(readLayout(fileName));
    console.log(`Rails: ${stats.rails}`);
    console.log(`Trains: ${stats.trains}`);
    console.log(`Unconnected connectors: ${stats.unconnectedConnectors}`);
    console.log(`Invalid connections: ${stats.invalidConnections}`);
    console.log(`Size: X ${format(stats.size.x)} × Y ${format(stats.size.y)} × Z ${format(stats.size.z)}`);
    console.log(`Physical size: X ${formatMeters(stats.size.x)} × Y ${formatMeters(stats.size.y)} × Z ${formatMeters(stats.size.z)}`);
    console.log(`Total path length (sum of all paths): ${formatMeters(stats.pathLength)} (approx.)`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

main();
