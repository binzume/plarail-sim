#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

require(path.join(__dirname, "..", "parts.js"));
const Layout = require(path.join(__dirname, "..", "layout.js"));
const { createLayoutSimulator } = require(path.join(__dirname, "..", "simulator.js"));
const PARTS = globalThis.PARTS;

const TRAIN_SPEED_MIN = 0.4;
const TRAIN_SPEED_MAX = 2.0;
const TRAIN_SPEED_DEFAULT = 1.0;
const TICK_TIME = 1 / 60;
const MIN_SIMULATION_DELTA_TIME = 0.0001;

function usage() {
  console.error(`Usage: node cmds/simulate.js <layout.json> [options]

Options:
  -s, --speed <number>  Simulation time multiplier (default: 1)
  -t, --time <seconds>  Simulation time limit (default: unlimited)
  -h, --help            Show this help`);
}

function parseNumber(value, optionName) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${optionName} must be a finite number`);
  return number;
}

function parseArgs(argv) {
  let layoutFile = null;
  let speed = 1;
  let time = Infinity;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") return { help: true };
    if (argument === "-s" || argument === "--speed") {
      speed = parseNumber(argv[++index], argument);
      continue;
    }
    if (argument === "-t" || argument === "--time") {
      time = parseNumber(argv[++index], argument);
      continue;
    }
    if (argument.startsWith("--speed=")) {
      speed = parseNumber(argument.slice("--speed=".length), "--speed");
      continue;
    }
    if (argument.startsWith("--time=")) {
      time = parseNumber(argument.slice("--time=".length), "--time");
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    if (layoutFile) throw new Error(`Unexpected argument: ${argument}`);
    layoutFile = argument;
  }

  if (!layoutFile) throw new Error("A layout file is required");
  if (!(speed > 0)) throw new Error("--speed must be greater than 0");
  if (time < 0) throw new Error("--time must not be negative");
  return { layoutFile, speed, time };
}

function trainSpeedForRail(rail) {
  const speed = Number(rail?.speed);
  if (!Number.isFinite(speed)) return TRAIN_SPEED_DEFAULT;
  return Number(Math.min(TRAIN_SPEED_MAX, Math.max(TRAIN_SPEED_MIN, speed)).toFixed(1));
}

function eventForRail(rail, part) {
  const name = part?.type === "rail" && typeof rail?.event?.name === "string"
    ? rail.event.name.trim()
    : "";
  return name ? { event: { name } } : {};
}

function readLayout(fileName) {
  const filePath = path.resolve(process.cwd(), fileName);
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const layout = Layout.normalizeLayout(PARTS, 1, data, {
    normalizeInstance: (rail, part) => ({
      ...(part?.type === "train"
        ? { speed: trainSpeedForRail(rail) }
        : {}),
      ...eventForRail(rail, part)
    })
  });
  if (!layout) throw new Error(`Invalid layout: ${fileName}`);
  return layout;
}

function formatTime(seconds) {
  return Number(seconds.toFixed(3));
}

function runSimulation(layout, speed, time) {
  const trainCount = layout.rails.filter(rail => PARTS[rail.part]?.type === "train").length;
  if (!trainCount) throw new Error("The layout does not contain any trains");

  const simulator = createLayoutSimulator({
    layout,
    parts: PARTS,
    onStart: trains => {
      console.log(JSON.stringify({
        type: "simulation-start",
        trains: trains.map(train => ({
          trainId: train.id,
          railId: train.railId
        }))
      }));
    }
  });
  if (!simulator.start()) throw new Error("Failed to start simulation");

  let finished = false;
  let timer = null;
  let lastFrame = { elapsed: 0, events: [] };

  const finish = reason => {
    if (finished) return;
    finished = true;
    if (timer !== null) clearTimeout(timer);
    if (simulator.isPlaying()) simulator.reset();
    console.error(`[simulator] stopped at ${formatTime(lastFrame.elapsed)}s (${reason})`);
  };

  const step = () => {
    if (finished) return;
    const remainingTime = time - lastFrame.elapsed;
    if (remainingTime <= MIN_SIMULATION_DELTA_TIME) {
      finish("time limit");
      return;
    }

    const wallTickTime = Math.max(TICK_TIME, MIN_SIMULATION_DELTA_TIME / speed);
    const deltaTime = Math.min(wallTickTime * speed, remainingTime);
    lastFrame = simulator.update(deltaTime) || lastFrame;
    for (const event of lastFrame.events || []) {
      console.log(JSON.stringify(event));
    }

    if (!simulator.isPlaying()) {
      finish("all trains stopped");
      return;
    }
    if (lastFrame.elapsed >= time) {
      finish("time limit");
      return;
    }
    timer = setTimeout(step, wallTickTime * 1000);
  };

  step();
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      usage();
      return;
    }
    runSimulation(readLayout(options.layoutFile), options.speed, options.time);
  } catch (error) {
    console.error(error.message);
    usage();
    process.exitCode = 1;
  }
}

main();
