#!/usr/bin/env python3
"""Start OmniRoute production server. Prints heartbeats to stay alive."""
import subprocess, sys, time, os, threading
from pathlib import Path

os.chdir(r"C:\Users\TBA\OmniRoute")
env = os.environ.copy()
env["PORT"] = "20128"

def heartbeat():
    while True:
        time.sleep(12)
        print(".", flush=True, end="")

t = threading.Thread(target=heartbeat, daemon=True)
t.start()

cmd = ["node", "--max-old-space-size=8192", ".build/next/standalone/server.js"]
proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)

for line in proc.stdout:
    print(line.rstrip(), flush=True)

proc.wait()
