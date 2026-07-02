#!/usr/bin/env bash
# Install the host-side auto-deploy as a launchd LaunchAgent on the always-on
# Mac. Run this ONCE on the host (it needs to run in the user session where
# Docker Desktop lives — a LaunchAgent, not a system LaunchDaemon).
#
#   ./scripts/install-autodeploy.sh          # install / reinstall
#   ./scripts/install-autodeploy.sh --uninstall
#
# Interval override: GRMC_DEPLOY_INTERVAL=120 ./scripts/install-autodeploy.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_DIR/scripts/auto-deploy.sh"
LABEL="com.grmc.autodeploy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
INTERVAL="${GRMC_DEPLOY_INTERVAL:-300}"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl unload -w "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "uninstalled $LABEL"
  exit 0
fi

if [ "$(uname)" != "Darwin" ]; then
  echo "This installer targets macOS (launchd). On Linux, run auto-deploy.sh from cron/systemd instead." >&2
  exit 1
fi

chmod +x "$SCRIPT"
mkdir -p "$HOME/Library/LaunchAgents"

cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SCRIPT</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_DIR</string>
    <key>StartInterval</key>
    <integer>$INTERVAL</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$REPO_DIR/auto-deploy.launchd.log</string>
    <key>StandardErrorPath</key>
    <string>$REPO_DIR/auto-deploy.launchd.log</string>
</dict>
</plist>
PLIST

# Reload (unload first so a changed plist is picked up).
launchctl unload -w "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo "installed $LABEL — runs every ${INTERVAL}s"
echo "  script:  $SCRIPT"
echo "  plist:   $PLIST"
echo "  logs:    $REPO_DIR/auto-deploy.log (deploy) + $REPO_DIR/auto-deploy.launchd.log (launchd)"
echo "Check status:  launchctl list | grep $LABEL"
echo "Run once now:  bash $SCRIPT && tail -n 20 $REPO_DIR/auto-deploy.log"
