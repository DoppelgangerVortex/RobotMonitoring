# Sensor agent

An AI agent for Arduino projects. It receives sensor readings over USB, works out which sensors you have, judges whether the readings are normal, and explains what's going on, with warnings and next steps when something is off.

```
Arduino ──USB──▶ bridge (your computer) ──HTTPS──▶ web app (Vercel) ──▶ Claude
                                                       │
                                                  dashboard + chat
```

What it does:

- **Identifies sensors** from your setup description plus the data itself: labels, units, value ranges, resolution, error text.
- **Checks instantly** with built-in rules for flatlines, spikes, pins stuck at 0/1023, `nan` values, DS18B20 `-127`, sketch error messages, and data that stopped arriving.
- **Assesses with Claude** about once a minute while new data arrives, and right away when a rule flags something. You get an overall status, a plain-language explanation per sensor, and warnings with what to do.
- **Answers questions** about the live readings in a chat panel.

## What you need

- An Arduino that prints readings over `Serial` (any format; see below)
- [Node.js](https://nodejs.org) 22 or newer on the computer the Arduino plugs into
- A Claude API key from [console.anthropic.com](https://console.anthropic.com/settings/keys)
- A free [Vercel](https://vercel.com) account and a GitHub account, to deploy

## 1. Try it on your computer first

```bash
npm install
cp .env.example .env.local     # then paste your ANTHROPIC_API_KEY into it
npm run dev                    # opens on http://localhost:3000
```

In a second terminal, feed it fake readings (no Arduino needed):

```bash
cd bridge
npm install
npm run simulate -- --scenario dry --backfill 300
```

Scenarios: `normal`, `heat`, `dry`, `fault` (loose wires), `smoke` (rising gas sensor).

## 2. Connect your Arduino

1. Upload a sketch that prints one line per reading. `arduino/sensor_agent_template` is a starting point. Most existing sketches work as-is. These formats are all understood:

   ```
   temp_c=23.4,humidity=51,soil_raw=512
   Humidity: 45.00 %  Temperature: 23.40 *C
   {"temp": 23.4, "hum": 51}
   23.4,51.0,512
   Failed to read from DHT sensor!
   ```

2. **Close the Arduino IDE's Serial Monitor** (only one program can use the port).
3. Start the bridge:

   ```bash
   cd bridge
   npm start                   # sends to http://localhost:3000
   npm run list                # if it can't find the Arduino: shows ports
   npm start -- --port COM3 --baud 115200   # pick a port / match Serial.begin()
   ```

4. In the dashboard, describe your setup under **Your setup** (board, sensors, pins, where they are). This makes sensor identification and "what's normal" much more accurate.

## 3. Deploy to Vercel

1. Push this folder to a new GitHub repository.
2. In Vercel: **Add New → Project**, import the repository. Keep the defaults (it detects Next.js).
3. Under **Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | your Claude API key |
   | `INGEST_TOKEN` | a long random string, e.g. from `node -e "console.log(crypto.randomUUID())"` |
   | `APP_PASSWORD` | a password for the dashboard |

4. Under **Storage**, add **Upstash Redis** (free tier works) and connect it to the project. Serverless functions don't share memory, so without this the readings won't stick around.
5. Redeploy (Deployments → ⋯ → Redeploy) so the new variables apply.
6. Point the bridge at your deployment. Create `bridge/.env`:

   ```
   APP_URL=https://your-app.vercel.app
   INGEST_TOKEN=the-same-token-as-on-vercel
   ```

   then run `npm start` in `bridge`. Open your Vercel URL and enter the dashboard password.

## Settings

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_MODEL` | server | `claude-sonnet-5-5` | Use `claude-haiku-5-5` for lower cost |
| `ASSESS_MIN_INTERVAL_SEC` | server | `20` | Minimum gap between automatic assessments |
| `BAUD` / `--baud` | bridge | `9600` | Must match `Serial.begin()` |
| `SERIAL_PORT` / `--port` | bridge | auto-detect | e.g. `COM3`, `/dev/ttyACM0`, `/dev/cu.usbmodem14101` |
| `BATCH_MS` / `--batch` | bridge | `5000` | How often the bridge sends |
| `DEVICE` / `--device` | bridge | `arduino` | Name shown to the agent |

**Cost.** Each assessment is one Claude API call with a compact summary of the data (a few thousand tokens). With the defaults and the dashboard open, that's at most about one call a minute, and none when no new data arrives. Turn off **Check automatically** to only check when you press the button. Chat questions are one call each.

**Upstash free tier.** The dashboard polls every 4 seconds only while its tab is visible, and the bridge sends every 5 seconds. Raise `BATCH_MS` if you leave things running for days.

## How it works

| Path | What it does |
|---|---|
| `lib/parse.ts` | Turns serial lines into named numeric fields |
| `lib/analyze.ts` | Stats, trends and the rule-based checks |
| `lib/agent.ts` | Prompt, data brief, structured assessment, chat |
| `lib/claude.ts` | Small Claude API client (no SDK needed) |
| `lib/store.ts` | Upstash Redis, or memory when running locally |
| `app/api/*` | `readings` (bridge posts here), `state`, `assess`, `chat`, `context` |
| `public/dashboard.js` | The dashboard (plain JavaScript, no build step) |
| `bridge/` | USB serial bridge and simulator |

Run `npm run selftest` to check the parser, the analysis and every API route (Claude is mocked; no key needed).

## Troubleshooting

- **Bridge says "Access denied" / "Resource busy"**: close the Serial Monitor or any other program using the port.
- **Garbled lines**: the baud rate doesn't match `Serial.begin()`. Pass `--baud`.
- **"the server rejected the token"**: `INGEST_TOKEN` in `bridge/.env` must exactly match the one on Vercel.
- **Banner about readings not being saved**: Upstash Redis isn't connected to the Vercel project yet, or you didn't redeploy after connecting it.
- **Linux permission error on `/dev/ttyACM0`**: `sudo usermod -aG dialout $USER`, then log out and back in.

**Safety note.** Hobby sensors aren't calibrated safety devices. The agent says so, and it treats possible smoke, gas or CO readings as a real hazard. Still, don't rely on it in place of a certified smoke or CO detector.
