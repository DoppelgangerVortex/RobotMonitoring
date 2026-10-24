"""
AI agent that monitors an Arduino over USB serial and records every
non-OK assessment on Solana (devnet by default) via the Memo program.

Setup:
    pip install anthropic pyserial solana solders
    export ANTHROPIC_API_KEY=your_key
    python agent.py --port /dev/ttyACM0      (Windows: --port COM3)

On first run it creates agent-wallet.json and airdrops devnet SOL to it.
"""
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
    "You monitor an Arduino board. You receive recent sensor readings as JSON "
    "(fields a and b are raw 0-1023 analog values). Reply with a JSON object: "
    '{"status": "ok" | "warning" | "critical", "reason": "<one sentence>"}. '
    "Flag flatlines (sensor stuck), sudden spikes, drift, or missing data. "
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", required=True)
    ap.add_argument("--baud", type=int, default=9600)
    args = ap.parse_args()

    wallet = load_wallet()
    ensure_funded(wallet)

    readings = deque(maxlen=WINDOW)
    count = 0
    last_seen = time.time()

    with serial.Serial(args.port, args.baud, timeout=2) as ser:
        print(f"Monitoring {args.port}, wallet {wallet.pubkey()}")
        while True:
            line = ser.readline().decode(errors="ignore").strip()

            if not line:
                if time.time() - last_seen > 10:
                    alert(wallet, {"status": "critical", "reason": "No data from Arduino for 10s"}, readings)
                    last_seen = time.time()
                continue

            try:
                reading = json.loads(line)
            except json.JSONDecodeError:
                continue

            reading["t"] = round(time.time(), 1)
            readings.append(reading)
            last_seen = time.time()
            count += 1

            if count % CHECK_EVERY == 0:
                result = assess(readings)
                if result["status"] != "ok":
                    alert(wallet, result, readings)
                else:
                    print("ok")


if __name__ == "__main__":
    main()
