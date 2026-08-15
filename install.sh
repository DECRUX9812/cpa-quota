#!/usr/bin/env bash
# Install cpa-quota into a Hermes Agent installation.
# Usage: ./install.sh
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HERMES_HOME/plugins/cpa-quota"

echo "→ Installing cpa-quota into $DEST"
mkdir -p "$DEST/dashboard" "$HERMES_HOME/desktop-plugins/cpa-quota"

cp "$SRC/plugin.yaml" "$SRC/__init__.py" "$SRC/config.example.json" "$DEST/"
cp "$SRC"/dashboard/* "$DEST/dashboard/"
cp "$SRC/desktop/plugin.js" "$HERMES_HOME/desktop-plugins/cpa-quota/plugin.js"

if command -v hermes >/dev/null 2>&1; then
  echo "→ Enabling plugin (hermes plugins enable cpa-quota)"
  hermes plugins enable cpa-quota || echo "⚠ enable manually: hermes plugins enable cpa-quota"
else
  echo "⚠ 'hermes' not on PATH — run 'hermes plugins enable cpa-quota' yourself"
fi

echo
echo "Done. Restart the dashboard (or relaunch the Hermes desktop app), then"
echo "open the 'AI Subscriptions' tab."
