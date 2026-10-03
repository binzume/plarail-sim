#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

require(path.join(__dirname, "..", "parts.js"));
const Layout = require(path.join(__dirname, "..", "layout.js"));
const PARTS = globalThis.PARTS;

const MM_PER_UNIT = 216 / 10;
const SNAP_DISTANCE = 24 / MM_PER_UNIT;
const ANGLE_TOLERANCE = 22.5;

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
    size
  };
}

function format(value) {
  return Number(value.toFixed(3));
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
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

main();
