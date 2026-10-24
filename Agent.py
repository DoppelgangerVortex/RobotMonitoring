
import argparse
import hashlib
import json
import os
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
 
try:
    import anthropic
except ImportError:
    sys.exit("Missing package: run  pip install anthropic pyserial solana solders")
 
MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5")
WINDOW = 30                 # readings kept in memory and sent to Claude
CHECK_EVERY = 30            # serial mode: ask Claude every N readings
CHECK_EVERY_LISTEN = 10     # listen mode default
STALE_SECONDS = 10          # serial mode: no data for this long is an alert
CHAIN_REPEAT_SECONDS = 60   # re-log an unchanged non-OK status at most this often
MAX_BODY = 64 * 1024
DEFAULT_RPC = "https://api.devnet.solana.com"
WALLET_FILE = "agent-wallet.json"
MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
 
SYSTEM = (
    "You monitor an Arduino project. You receive its most recent readings as a JSON "
    "array, oldest first. Each reading has a timestamp t (Unix seconds, added on "
    "arrival) plus whatever fields the Arduino sent. Work out what each field most "
    "likely is from its name and values: for example button_pressed is a push button "
    "(true while held), and integers from 0 to 1023 are raw 10-bit analog readings "
    "(a potentiometer, light sensor, etc.) with no physical unit.\n"
    "Judge whether the behaviour looks normal. Flag a button stuck pressed for a "
    "long time, rapid chatter or bouncing, sensors that flatline, spike, drift, sit "
    "at 0 or 1023, fields that disappear, and gaps in the timestamps. Normal button "
    "presses and normal sensor variation are ok. Separate likely wiring or code "
    "problems from real-world events, and say which you think it is.\n"
    "Use only the data provided. Report with the submit_assessment tool."
)
 
ASSESS_TOOL = {
    "name": "submit_assessment",
    "description": "Report the assessment of the recent Arduino readings.",
    "input_schema": {
        "type": "object",
        "properties": {
            "status": {
                "type": "string",
                "enum": ["ok", "warning", "critical"],
                "description": "ok = normal; warning = needs attention; critical = act now.",
            },
            "reason": {
                "type": "string",
                "description": "One plain-language sentence, under 120 characters.",
            },
            "details": {
                "type": "string",
                "description": "2-3 sentences: what the readings show and what to check or do.",
            },
            "sensors": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Each field and what it most likely is, e.g. 'a: analog input, likely a potentiometer'.",
            },
        },
        "required": ["status", "reason", "details", "sensors"],
    },
}
 
 
def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
 
 
def log(msg):
    print(f"{time.strftime('%H:%M:%S')}  {msg}", flush=True)
 
 
# ---------- Solana ----------
 
class Chain:
    """Writes short memos to Solana. Every failure is reported, never fatal."""
 
    def __init__(self, rpc_url):
        from solana.rpc.api import Client
        from solders.instruction import AccountMeta, Instruction
        from solders.keypair import Keypair
        from solders.message import Message
        from solders.pubkey import Pubkey
        from solders.transaction import Transaction
 
        self._AccountMeta, self._Instruction = AccountMeta, Instruction
        self._Message, self._Transaction = Message, Transaction
        self._memo_program = Pubkey.from_string(MEMO_PROGRAM_ID)
        self.rpc_url = rpc_url
        self.client = Client(rpc_url)
        self.cluster = "devnet" if "devnet" in rpc_url else "testnet" if "testnet" in rpc_url else "mainnet-beta"
        self.wallet = self._load_wallet(Keypair)
 
    def _load_wallet(self, Keypair):
        if os.path.exists(WALLET_FILE):
            with open(WALLET_FILE) as f:
                return Keypair.from_bytes(bytes(json.load(f)))
        kp = Keypair()
        with open(WALLET_FILE, "w") as f:
            json.dump(list(bytes(kp)), f)
        try:
            os.chmod(WALLET_FILE, 0o600)
        except OSError:
            pass
        log(f"Created wallet {kp.pubkey()} in {WALLET_FILE} (keep this file private)")
        return kp
 
    @property
    def address(self):
        return str(self.wallet.pubkey())
 
    def ensure_funded(self):
        try:
            bal = self.client.get_balance(self.wallet.pubkey()).value
        except Exception as e:
            log(f"Couldn't check the wallet balance ({e}). Solana logging may fail.")
            return
        if bal >= 10_000:
            log(f"Wallet {self.address} has {bal / 1e9:.4f} SOL on {self.cluster}.")
            return
        if self.cluster != "devnet":
            log(f"Wallet {self.address} is empty. Send it some SOL to enable logging.")
            return
        log("Wallet is empty. Requesting 1 devnet SOL…")
        try:
            self.client.request_airdrop(self.wallet.pubkey(), 1_000_000_000)
            for _ in range(15):
                time.sleep(2)
                if self.client.get_balance(self.wallet.pubkey()).value > 0:
                    log("Airdrop received.")
                    return
            log("Airdrop not confirmed yet. It may still arrive.")
        except Exception as e:
            log(f"Airdrop failed ({e}). The devnet faucet is often rate-limited.")
            log(f"Get devnet SOL at https://faucet.solana.com for {self.address}, "
                "then restart. The agent keeps running meanwhile.")
 
    def log_memo(self, result, readings):
        """Write status, reason and a hash of the evidence. Returns the signature."""
        digest = hashlib.sha256(json.dumps(list(readings), sort_keys=True).encode()).hexdigest()[:16]
        memo = json.dumps(
            {"s": result["status"], "r": result["reason"][:120], "h": digest, "t": int(time.time())},
            separators=(",", ":"),
        ).encode()
        ix = self._Instruction(
            self._memo_program, memo,
            [self._AccountMeta(self.wallet.pubkey(), is_signer=True, is_writable=False)],
        )
        blockhash = self.client.get_latest_blockhash().value.blockhash
        msg = self._Message.new_with_blockhash([ix], self.wallet.pubkey(), blockhash)
        tx = self._Transaction([self.wallet], msg, blockhash)
        return str(self.client.send_transaction(tx).value)
 
 
# ---------- Agent ----------
 
def clean_result(raw):
    """Never let a malformed reply reach the dashboard or the chain."""
    raw = raw if isinstance(raw, dict) else {}
    status = raw.get("status") if raw.get("status") in ("ok", "warning", "critical") else "warning"
    reason = str(raw.get("reason") or "The agent returned an incomplete assessment.").strip()[:200]
    details = str(raw.get("details") or "").strip()[:800]
    sensors = [str(s)[:120] for s in raw.get("sensors", []) if s][:12] if isinstance(raw.get("sensors"), list) else []
    return {"status": status, "reason": reason, "details": details, "sensors": sensors}
 
 
def assess(claude, readings):
    msg = claude.messages.create(
        model=MODEL,
        max_tokens=800,
        system=SYSTEM,
        tools=[ASSESS_TOOL],
        tool_choice={"type": "tool", "name": ASSESS_TOOL["name"]},
        messages=[{"role": "user", "content": json.dumps(list(readings))}],
    )
    block = next((b for b in msg.content if getattr(b, "type", "") == "tool_use"), None)
    return clean_result(block.input if block else None)
 
 
class Monitor:
    def __init__(self, claude, chain, check_every):
        self.claude = claude
        self.chain = chain
        self.check_every = check_every
        self.readings = deque(maxlen=WINDOW)
        self.count = 0
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.last_logged = (None, 0.0)  # (status, time) of the last on-chain memo
        self.result = {
            "status": "pending",
            "reason": f"No assessment yet. The first one runs after {check_every} readings.",
            "details": "",
            "sensors": [],
            "assessed_at": None,
            "readings_assessed": 0,
            "signature": None,
            "chain_error": None,
            "agent_error": None,
        }
        self.assessing = False
        threading.Thread(target=self._worker, daemon=True).start()
 
    # Called for every reading. Returns immediately; Claude runs in the background.
    def ingest(self, reading):
        with self.lock:
            reading = dict(reading)
            reading["t"] = round(time.time(), 1)
            self.readings.append(reading)
            self.count += 1
            due = self.count % self.check_every == 0
        if due:
            self.wake.set()
 
    def status(self):
        with self.lock:
            out = dict(self.result)
            out.update(
                events_received=self.count,
                assessing=self.assessing,
                check_every=self.check_every,
                model=MODEL,
                chain_enabled=self.chain is not None,
                cluster=self.chain.cluster if self.chain else None,
                wallet=self.chain.address if self.chain else None,
            )
            return out
 
    def _worker(self):
        while True:
            self.wake.wait()
            self.wake.clear()
            with self.lock:
                snapshot = list(self.readings)
                self.assessing = True
            try:
                result = assess(self.claude, snapshot)
            except Exception as e:
                log(f"Claude request failed: {e}")
                with self.lock:
                    self.assessing = False
                    self.result = {**self.result, "agent_error": f"Last Claude request failed: {e}"[:300]}
                continue
            result.update(assessed_at=now_iso(), readings_assessed=len(snapshot),
                          signature=None, chain_error=None, agent_error=None)
            if result["status"] == "ok":
                log(f"OK: {result['reason']}")
            else:
                self.alert(result, snapshot)
            with self.lock:
                self.result = result
                self.assessing = False
 
    def alert(self, result, snapshot):
        """Prints the alert and records it on Solana (fills in signature / chain_error)."""
        log(f"{result['status'].upper()}: {result['reason']}")
        if not self.chain:
            return
        last_status, last_time = self.last_logged
        if result["status"] == last_status and time.time() - last_time < CHAIN_REPEAT_SECONDS:
            result["chain_error"] = f"Same status logged under {CHAIN_REPEAT_SECONDS}s ago; not logged again."
            return
        try:
            sig = self.chain.log_memo(result, snapshot)
            self.last_logged = (result["status"], time.time())
            result["signature"] = sig
            log(f"  logged on Solana ({self.chain.cluster}): {sig}")
        except Exception as e:
            result["chain_error"] = f"Solana logging failed: {e}"[:300]
            log(f"  Solana logging failed: {e}")
 
 
# ---------- HTTP (listen mode) ----------
 
def make_handler(monitor):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, body=b"{}"):
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            # Lets Chrome pages served from another origin reach this local server.
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
 
        def _json(self, code, obj):
            self._send(code, json.dumps(obj).encode())
 
        def do_OPTIONS(self):
            self._send(204, b"")
 
        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/status":
                self._json(200, monitor.status())
            elif path in ("/", "/health"):
                self._json(200, {"agent": "running", "endpoints": ["GET /status", "POST /event"]})
            else:
                self._json(404, {"error": "not found"})
 
        def do_POST(self):
            if urlparse(self.path).path != "/event":
                return self._json(404, {"error": "not found"})
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length <= 0 or length > MAX_BODY:
                    raise ValueError("empty or too large")
                reading = json.loads(self.rfile.read(length))
                if not isinstance(reading, dict):
                    raise ValueError("not a JSON object")
            except (ValueError, json.JSONDecodeError) as e:
                return self._json(400, {"error": f"send one JSON object per request ({e})"})
            monitor.ingest(reading)
            self._json(200, {"ok": True, "events_received": monitor.count})
 
        def log_message(self, *args):
            pass
 
    return Handler
 
 
# ---------- Serial mode ----------
 
def run_serial(monitor, port, baud):
    try:
        import serial
    except ImportError:
        sys.exit("Missing package: run  pip install pyserial")
    last_seen = time.time()
    outage_reported = False
    with serial.Serial(port, baud, timeout=2) as ser:
        log(f"Monitoring {port} at {baud} baud.")
        while True:
            line = ser.readline().decode(errors="ignore").strip()
            if not line:
                if not outage_reported and time.time() - last_seen > STALE_SECONDS:
                    result = {"status": "critical", "reason": f"No data from Arduino for {STALE_SECONDS}s",
                              "details": "Check the USB cable, the sketch, and the baud rate.",
                              "sensors": [], "assessed_at": now_iso(),
                              "readings_assessed": len(monitor.readings),
                              "signature": None, "chain_error": None}
                    monitor.alert(result, list(monitor.readings))
                    with monitor.lock:
                        monitor.result = result
                    outage_reported = True  # one alert per outage, not one every 10s
                continue
            try:
                reading = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(reading, dict):
                continue
            if outage_reported:
                log("Data is arriving again.")
            last_seen = time.time()
            outage_reported = False
            monitor.ingest(reading)
 
 
def main():
    ap = argparse.ArgumentParser(description="Arduino monitoring agent")
    ap.add_argument("--port", help="serial port; the agent reads the Arduino directly")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--listen", type=int, metavar="PORT",
                    help="HTTP port to receive readings from dashboard.html")
    ap.add_argument("--check-every", type=int,
                    help=f"ask Claude every N readings (default {CHECK_EVERY} serial, {CHECK_EVERY_LISTEN} listen)")
    ap.add_argument("--no-chain", action="store_true", help="don't log anything to Solana")
    ap.add_argument("--rpc", default=os.environ.get("SOLANA_RPC_URL", DEFAULT_RPC),
                    help="Solana RPC URL (default devnet)")
    args = ap.parse_args()
    if bool(args.port) == bool(args.listen):
        ap.error("choose exactly one of --port or --listen")
    if args.check_every is not None and args.check_every < 1:
        ap.error("--check-every must be at least 1")
 
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY is not set. Set it in this terminal, then run again.")
    claude = anthropic.Anthropic()
 
    chain = None
    if not args.no_chain:
        try:
            chain = Chain(args.rpc)
        except ImportError:
            sys.exit("Missing package for Solana logging: pip install solana solders "
                     "(or run with --no-chain)")
        if chain.cluster == "mainnet-beta":
            log("WARNING: logging to Solana mainnet costs real SOL for every alert.")
        chain.ensure_funded()
 
    monitor = Monitor(claude, chain, args.check_every or (CHECK_EVERY_LISTEN if args.listen else CHECK_EVERY))
 
    if args.listen:
        server = ThreadingHTTPServer(("127.0.0.1", args.listen), make_handler(monitor))
        log(f"Agent listening on http://localhost:{args.listen}  (Ctrl+C to stop)")
        log(f"Assessing every {monitor.check_every} readings with {MODEL}. "
            f"Solana logging: {'on, ' + chain.cluster if chain else 'off'}.")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            log("Stopped.")
    else:
        try:
            run_serial(monitor, args.port, args.baud)
        except KeyboardInterrupt:
            log("Stopped.")
 
 
if __name__ == "__main__":
    main()
 
