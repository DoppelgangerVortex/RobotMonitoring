import argparse
import hashlib
import json
import os
import time
from collections import deque

import anthropic
import serial
from solana.rpc.api import Client
from solders.instruction import AccountMeta, Instruction
from """
AI agent that monitors an Arduino over USB serial and records every
non-OK assessment on Solana (devnet by default) via the Memo program.
 
Setup:
    pip install anthropic pyserial solana solders
    export ANTHROPIC_API_KEY=your_key
    python agent.py --port /dev/ttyACM0      (agent reads the Arduino itself)
    python agent.py --listen 8765            (browser dashboard.html reads the
                                              Arduino and posts events here)
 
On first run it creates agent-wallet.json and airdrops devnet SOL to it.
"""
import argparse
import hashlib
import json
import os
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
 
import anthropic
import serial
from solana.rpc.api import Client
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.message import Message
from solders.pubkey import Pubkey
from solders.transaction import Transaction
 
MODEL = "claude-sonnet-5-5"
WINDOW = 30            # readings kept in memory
CHECK_EVERY = 30       # ask Claude every N readings
RPC_URL = "https://api.devnet.solana.com"   # change for mainnet
WALLET_FILE = "agent-wallet.json"
MEMO_PROGRAM_ID = Pubkey.from_string("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
 
SYSTEM = (
    "You monitor an Arduino board. You receive recent readings as JSON, each with "
    "a timestamp t (seconds) and either button_pressed (boolean) or analog values "
    "a and b (0-1023). Reply with a JSON object: "
    '{"status": "ok" | "warning" | "critical", "reason": "<one sentence>"}. '
    "Flag a button stuck pressed for a long time, rapid chatter/bouncing, "
    "flatlined or spiking sensors, drift, or missing data. Normal presses are ok. "
    "Reply with JSON only."
)
 
claude = anthropic.Anthropic()
solana = Client(RPC_URL)
 
 
# ---------- Solana ----------
def load_wallet() -> Keypair:
    if os.path.exists(WALLET_FILE):
        with open(WALLET_FILE) as f:
            return Keypair.from_bytes(bytes(json.load(f)))
    kp = Keypair()
    with open(WALLET_FILE, "w") as f:
        json.dump(list(bytes(kp)), f)
    print(f"Created wallet {kp.pubkey()} -> {WALLET_FILE} (keep this file private)")
    return kp
 
 
def ensure_funded(kp: Keypair):
    bal = solana.get_balance(kp.pubkey()).value
    if bal < 10_000 and "devnet" in RPC_URL:
        print("Requesting devnet airdrop...")
        solana.request_airdrop(kp.pubkey(), 1_000_000_000)  # 1 SOL
        time.sleep(15)
 
 
def log_onchain(kp: Keypair, result: dict, readings) -> str:
    """Write a short memo: status, reason, and a hash of the evidence."""
    digest = hashlib.sha256(json.dumps(list(readings)).encode()).hexdigest()[:16]
    memo = json.dumps(
        {"s": result["status"], "r": result["reason"][:120], "h": digest, "t": int(time.time())},
        separators=(",", ":"),
    ).encode()
 
    ix = Instruction(
        MEMO_PROGRAM_ID,
        memo,
        [AccountMeta(kp.pubkey(), is_signer=True, is_writable=False)],
    )
    blockhash = solana.get_latest_blockhash().value.blockhash
    msg = Message.new_with_blockhash([ix], kp.pubkey(), blockhash)
    tx = Transaction([kp], msg, blockhash)
    return str(solana.send_transaction(tx).value)
 
 
# ---------- Agent ----------
def assess(readings):
    msg = claude.messages.create(
        model=MODEL,
        max_tokens=300,
        system=SYSTEM,
        messages=[{"role": "user", "content": json.dumps(list(readings))}],
    )
    text = msg.content[0].text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"status": "warning", "reason": f"Unparseable reply: {text[:100]}"}
 
 
def alert(wallet, result, readings):
    print(f"[{result['status'].upper()}] {result['reason']}")
    try:
        sig = log_onchain(wallet, result, readings)
        print(f"  logged on Solana: {sig}")
    except Exception as e:
        print(f"  Solana logging failed: {e}")
 
 
class Monitor:
    def __init__(self, wallet, check_every):
        self.wallet = wallet
        self.check_every = check_every
        self.readings = deque(maxlen=WINDOW)
        self.count = 0
        self.last_result = {"status": "ok", "reason": "No assessment yet"}
        self.lock = threading.Lock()
 
    def ingest(self, reading):
        with self.lock:
            reading["t"] = round(time.time(), 1)
            self.readings.append(reading)
            self.count += 1
            if self.count % self.check_every:
                return
            snapshot = list(self.readings)
        result = assess(snapshot)
        self.last_result = result
        if result["status"] != "ok":
            alert(self.wallet, result, snapshot)
        else:
            print("ok")
 
 
def make_handler(monitor):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, body=b"{}"):
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.end_headers()
            self.wfile.write(body)
 
        def do_OPTIONS(self):
            self._send(204, b"")
 
        def do_GET(self):
            if self.path == "/status":
                self._send(200, json.dumps(monitor.last_result).encode())
            else:
                self._send(404)
 
        def do_POST(self):
            if self.path != "/event":
                return self._send(404)
            try:
                length = int(self.headers.get("Content-Length", 0))
                reading = json.loads(self.rfile.read(length))
                if not isinstance(reading, dict):
                    raise ValueError("not an object")
            except (ValueError, json.JSONDecodeError):
                return self._send(400)
            monitor.ingest(reading)
            self._send(200, b'{"ok":true}')
 
        def log_message(self, *args):
            pass
 
    return Handler
 
 
def run_serial(monitor, port, baud):
    last_seen = time.time()
    with serial.Serial(port, baud, timeout=2) as ser:
        print(f"Monitoring {port}, wallet {monitor.wallet.pubkey()}")
        while True:
            line = ser.readline().decode(errors="ignore").strip()
            if not line:
                if time.time() - last_seen > 10:
                    alert(monitor.wallet,
                          {"status": "critical", "reason": "No data from Arduino for 10s"},
                          monitor.readings)
                    last_seen = time.time()
                continue
            try:
                reading = json.loads(line)
            except json.JSONDecodeError:
                continue
            last_seen = time.time()
            monitor.ingest(reading)
 
 
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", help="serial port, agent reads the Arduino directly")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--listen", type=int, metavar="PORT",
                    help="HTTP port to receive events from dashboard.html")
    ap.add_argument("--check-every", type=int,
                    help="ask Claude every N readings (default 30 serial, 10 listen)")
    args = ap.parse_args()
    if bool(args.port) == bool(args.listen):
        ap.error("choose exactly one of --port or --listen")
 
    wallet = load_wallet()
    ensure_funded(wallet)
    monitor = Monitor(wallet, args.check_every or (10 if args.listen else CHECK_EVERY))
 
    if args.listen:
        print(f"Listening on http://localhost:{args.listen}, wallet {wallet.pubkey()}")
        ThreadingHTTPServer(("127.0.0.1", args.listen), make_handler(monitor)).serve_forever()
    else:
        run_serial(monitor, args.port, args.baud)
 
 
if __name__ == "__main__":
    main()
 
