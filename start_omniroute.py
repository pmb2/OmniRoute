#!/usr/bin/env python3
"""Start OmniRoute with heartbeat loop to keep it alive."""
import subprocess, sys, time, os
from pathlib import Path

OMNIROUTE_DIR = Path(r"C:\Users\TBA\OmniRoute")
LOG = OMNIROUTE_DIR / "data" / "omniroute.log"

def log(msg):
    t = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG, "a") as f:
        f.write(f"[{t}] {msg}\n")

if __name__ == "__main__":
    os.chdir(str(OMNIROUTE_DIR))
    cmd = ["node", "--max-old-space-size=8192", "scripts/dev/run-next.mjs", "dev"]
    
    log("Starting OmniRoute...")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1)
    
    # Monitor output and keep alive
    while True:
        try:
            line = proc.stdout.readline()
            if line:
                print(line, end="", flush=True)
            else:
                # No output for a while — heartbeat
                print("[heartbeat]", flush=True)
                log("heartbeat")
                time.sleep(15)
        except:
            break
    
    proc.wait()
    log(f"OmniRoute exited: {proc.returncode}")
