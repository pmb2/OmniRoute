@echo off
rem OmniRoute auto-start wrapper (logon scheduled task) - keeps the router up across reboots.
cd /d C:\Users\TBA\OmniRoute
node --max-old-space-size=8192 scripts/dev/run-next.mjs dev >> data\omniroute-autostart.log 2>&1
