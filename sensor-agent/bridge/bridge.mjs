#!/usr/bin/env node
// USB serial → sensor agent bridge.
//
// Run on the computer the Arduino is plugged into:
//   npm install
//   npm start -- --url https://your-app.vercel.app --token YOUR_INGEST_TOKEN
//
// Other modes:
//   npm run list                  show serial ports, to find your Arduino
//   some-command | node bridge.mjs --stdin   forward lines from another program
//
// Close the Arduino IDE's Serial Monitor first: only one program can use the port.

import { createInterface } from "node:readline";
import { config, send } from "./config.mjs";

const cfg = config();
const MAX_QUEUE = 10000;
const MAX_BATCH = 500;
const KNOWN_VENDORS = new Set(["2341", "2a03", "1a86", "0403", "10c4", "239a", "303a", "1b4f", "2e8a"]);

/** @type {{ raw: string, t: number }[]} */
let queue = [];
let lastSendState = "";
let sentTotal = 0;
let stopping = false;

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

function enqueue(raw) {
  const line = raw.replace(/\r$/, "");
  if (!line.trim()) return;
  if (!cfg.quiet) console.log(`  ${line}`);
  queue.push({ raw: line, t: Date.now() });
  if (queue.length > MAX_QUEUE) {
    const dropped = queue.length - MAX_QUEUE;
    queue = queue.slice(dropped);
    log(`Queue full: dropped ${dropped} old line(s) while the server was unreachable.`);
  }
}

async function flush() {
  while (queue.length) {
    const batch = queue.slice(0, MAX_BATCH);
    const r = await send(cfg, batch);
    if (!r.ok) {
      const state = `fail:${r.message}`;
      if (state !== lastSendState) log(`Not sent: ${r.message} (${queue.length} waiting, will retry)`);
      lastSendState = state;
      return;
    }
    queue = queue.slice(batch.length);
    sentTotal += batch.length;
    if (lastSendState !== "ok") log(`Connected to ${cfg.url}. Sending readings.`);
    lastSendState = "ok";
  }
}

async function loop() {
  while (!stopping) {
    await flush();
    await new Promise((r) => setTimeout(r, cfg.batchMs));
  }
}

async function loadSerial() {
  try {
    return await import("serialport");
  } catch {
    console.error('The "serialport" package is missing. Run "npm install" in the bridge folder first.');
    process.exit(1);
  }
}

async function listPorts(SerialPort) {
  const ports = await SerialPort.list();
  if (!ports.length) console.log("No serial ports found. Is the Arduino plugged in?");
  for (const p of ports) {
    const tag = isLikelyArduino(p) ? "  ← likely an Arduino" : "";
    console.log(`${p.path}  ${p.manufacturer || ""} ${p.vendorId ? `[${p.vendorId}:${p.productId}]` : ""}${tag}`);
  }
  return ports;
}

function isLikelyArduino(p) {
  return (
    (p.vendorId && KNOWN_VENDORS.has(String(p.vendorId).toLowerCase())) ||
    /arduino|wch|ch34|ftdi|silicon labs|cp210|usb.?serial|adafruit|espressif|raspberry pi/i.test(p.manufacturer || "")
  );
}

async function pickPort(SerialPort) {
  if (cfg.port) return String(cfg.port);
  const ports = await SerialPort.list();
  const likely = ports.filter(isLikelyArduino);
  if (likely.length >= 1) return likely[0].path;
  if (ports.length === 1) return ports[0].path;
  return null;
}

async function runSerial() {
  const { SerialPort, ReadlineParser } = await loadSerial();
  if (cfg.flags.list) {
    await listPorts(SerialPort);
    return;
  }

  let announcedWaiting = false;
  const open = async () => {
    if (stopping) return;
    const path = await pickPort(SerialPort);
    if (!path) {
      if (!announcedWaiting) {
        log("No Arduino found. Plug it in, or pass --port (run `npm run list` to see ports). Retrying…");
        announcedWaiting = true;
      }
      setTimeout(open, 3000);
      return;
    }
    const port = new SerialPort({ path, baudRate: cfg.baud, autoOpen: false });
    const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
    parser.on("data", enqueue);
    port.on("close", () => {
      if (stopping) return;
      log(`Serial port ${path} closed. Reconnecting…`);
      setTimeout(open, 3000);
    });
    port.on("error", (e) => log(`Serial error: ${e.message}`));
    port.open((err) => {
      if (err) {
        log(`Can't open ${path}: ${err.message}${/access|busy|locked/i.test(err.message) ? " (close the Arduino Serial Monitor)" : ""}. Retrying…`);
        setTimeout(open, 3000);
        return;
      }
      announcedWaiting = false;
      log(`Reading ${path} at ${cfg.baud} baud. Sending to ${cfg.url} every ${cfg.batchMs / 1000}s.`);
    });
  };
  await open();
}

function runStdin() {
  log(`Reading lines from stdin. Sending to ${cfg.url} every ${cfg.batchMs / 1000}s.`);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", enqueue);
  rl.on("close", async () => {
    await flush();
    log(`Input ended. Sent ${sentTotal} line(s).`);
    process.exit(queue.length ? 1 : 0);
  });
}

process.on("SIGINT", async () => {
  stopping = true;
  log("Stopping. Sending what's left…");
  await flush();
  process.exit(0);
});

if (!cfg.token && !/localhost|127\.0\.0\.1/.test(cfg.url)) {
  console.error("Set INGEST_TOKEN (or pass --token). It must match INGEST_TOKEN on the server.");
  process.exit(1);
}

if (cfg.flags.stdin) runStdin();
else runSerial();
if (!cfg.flags.list) loop();
