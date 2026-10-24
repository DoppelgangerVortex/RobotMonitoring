#!/usr/bin/env node
// Pretends to be an Arduino with a DHT22 (temperature + humidity) and a
// capacitive soil moisture sensor on A0, so you can try the agent without hardware.
//
//   node simulate.mjs --scenario normal       everything fine
//   node simulate.mjs --scenario heat         room heating up past comfortable
//   node simulate.mjs --scenario dry          plant soil drying out
//   node simulate.mjs --scenario fault        loose DHT22 wire and a floating A0 pin
//   node simulate.mjs --scenario smoke        adds an MQ-2 gas sensor that starts rising
//
// Add --backfill 240 to send 240 past readings at once so the charts fill in.
// Uses the same --url / --token settings as the bridge.

import { config, send } from "./config.mjs";

const cfg = config();
const scenario = String(cfg.flags.scenario || "normal");
const intervalMs = Number(cfg.flags.interval || 2000);
const backfill = Number(cfg.flags.backfill || 0);

const noise = (s) => (Math.random() - 0.5) * 2 * s;
const fix = (v, d) => v.toFixed(d);

/** Produces the line the Arduino would print at step i (of a ~2 s loop). */
function line(i) {
  const minutes = (i * intervalMs) / 60000;
  let temp = 22.4 + 0.4 * Math.sin(minutes / 9) + noise(0.1);
  let hum = 47 + 1.5 * Math.sin(minutes / 13) + noise(0.4);
  let soil = Math.round(420 + noise(4));
  let gas = Math.round(118 + noise(6));

  if (scenario === "heat") {
    temp += Math.min(16, minutes * 0.9);
    hum -= Math.min(18, minutes * 0.8);
  }
  if (scenario === "dry") soil = Math.round(420 + Math.min(230, minutes * 14) + noise(4));
  if (scenario === "smoke") gas = Math.round(118 + (minutes > 4 ? Math.min(560, (minutes - 4) ** 2 * 22) : 0) + noise(8));

  if (scenario === "fault") {
    if (i % 9 === 4 || (minutes > 5 && i % 3 === 0)) return "Failed to read from DHT sensor!";
    if (minutes > 5 && i % 3 === 1) return `Humidity: nan %\tTemperature: nan *C\tsoil=1023`;
    if (minutes > 3) soil = 1023;
  }

  const dht = `Humidity: ${fix(hum, 2)} %\tTemperature: ${fix(temp, 2)} *C`;
  return scenario === "smoke" ? `${dht}\tsoil=${soil}\tgas=${gas}` : `${dht}\tsoil=${soil}`;
}

async function main() {
  console.log(`Simulating "${scenario}" → ${cfg.url}`);
  let i = 0;
  if (backfill > 0) {
    const now = Date.now();
    const lines = [];
    for (; i < backfill; i++) lines.push({ raw: line(i), t: now - (backfill - i) * intervalMs });
    lines.unshift({ raw: "DHTxx test! Soil sensor on A0", t: now - (backfill + 1) * intervalMs });
    for (let k = 0; k < lines.length; k += 500) {
      const r = await send(cfg, lines.slice(k, k + 500));
      console.log(r.ok ? `Backfilled ${Math.min(k + 500, lines.length)} lines` : `Backfill failed: ${r.message}`);
      if (!r.ok) process.exit(1);
    }
  }
  if (cfg.flags.once) return;
  setInterval(async () => {
    const raw = line(i++);
    const r = await send(cfg, [{ raw, t: Date.now() }]);
    console.log(r.ok ? `  ${raw}` : `Not sent: ${r.message}`);
  }, intervalMs);
}

main();
