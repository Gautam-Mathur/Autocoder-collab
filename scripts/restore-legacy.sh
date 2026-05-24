#!/usr/bin/env bash
# RuFlo Fusion — Legacy Restore Backdoor
#
# One-command rollback that fully re-enables the legacy 17-stage pipeline.
# Use ONLY if RuFlo regresses badly.
#
# What it does:
#   1. Copies the four quarantined modules from AutoCoder/legacy/api-server-modules/
#      back into AutoCoder/artifacts/api-server/src/src/modules/
#   2. Restores routes/autocoder.ts from the pre-quarantine snapshot, undoing
#      every 410-Gone stub and re-wiring the original imports/handlers.
#   3. Removes the legacy-stubs shim so its symbols can no longer mask real ones.
#
# After running, restart the API server workflow:
#   AutoCoder/artifacts/api-server: API Server
#
# This script is the ONLY supported path back to the legacy pipeline.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LEGACY_DIR="$ROOT/AutoCoder/legacy/api-server-modules"
DEST_MODULES="$ROOT/AutoCoder/artifacts/api-server/src/src/modules"
DEST_ROUTE="$ROOT/AutoCoder/artifacts/api-server/src/src/routes/autocoder.ts"
ROUTE_SNAPSHOT="$LEGACY_DIR/autocoder.ts.pre-quarantine"

if [ ! -d "$LEGACY_DIR" ]; then
  echo "ERROR: legacy folder missing at $LEGACY_DIR" >&2
  exit 1
fi
if [ ! -f "$ROUTE_SNAPSHOT" ]; then
  echo "ERROR: pre-quarantine route snapshot missing at $ROUTE_SNAPSHOT" >&2
  exit 1
fi

echo "[1/3] Restoring legacy modules -> $DEST_MODULES"
for f in planning-module.ts advanced-code-generation.ts deep-project-generator.ts reverse-plan-generator.ts; do
  if [ ! -f "$LEGACY_DIR/$f" ]; then
    echo "  WARN: $f missing from legacy folder, skipping"
    continue
  fi
  cp -v "$LEGACY_DIR/$f" "$DEST_MODULES/$f"
done

echo "[2/3] Restoring routes/autocoder.ts from pre-quarantine snapshot"
cp -v "$ROUTE_SNAPSHOT" "$DEST_ROUTE"

echo "[3/3] Removing legacy-stubs shim"
rm -fv "$DEST_MODULES/legacy-stubs.ts"

echo ""
echo "Done. Restart the API Server workflow to pick up the changes:"
echo "  AutoCoder/artifacts/api-server: API Server"
echo ""
echo "Legacy 17-stage pipeline endpoints are now active again. RuFlo is bypassed."
