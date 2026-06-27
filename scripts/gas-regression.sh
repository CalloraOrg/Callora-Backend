#!/usr/bin/env bash
#
# gas-regression.sh - Per-entrypoint CPU/memory budget regression checker
#
# Usage:
#   ./scripts/gas-regression.sh            # Check against baseline (CI mode)
#   ./scripts/gas-regression.sh --update   # Update baseline with current measurements
#   ./scripts/gas-regression.sh --json     # Output JSON for machine parsing
#   ./scripts/gas-regression.sh --help     # Show this help
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASELINE_FILE="$PROJECT_ROOT/contracts/.gas-baseline.json"

show_help() {
  sed -n '3,12p' "$0"
  exit 0
}

UPDATE=false
JSON=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --update) UPDATE=true; shift ;;
    --json)   JSON=true;   shift ;;
    --help)   show_help           ;;
    *)        echo "Unknown option: $1"; show_help ;;
  esac
done

echo "=== Gas Regression Check ==="
echo "Project root: $PROJECT_ROOT"
echo "Baseline:     $BASELINE_FILE"
echo ""

if [ ! -f "$BASELINE_FILE" ]; then
  if [ "$UPDATE" = false ]; then
    echo "ERROR: No baseline found at $BASELINE_FILE"
    echo "Run with --update first to generate a baseline."
    exit 1
  fi
  echo "No existing baseline — will create one."
fi

TSX_ARGS=("$SCRIPT_DIR/gas-regression.ts")
if [ "$UPDATE" = true ]; then
  TSX_ARGS+=("--update")
fi
if [ "$JSON" = true ]; then
  TSX_ARGS+=("--json")
fi

echo "Running: npx tsx ${TSX_ARGS[*]}"
echo ""

if npx tsx "${TSX_ARGS[@]}"; then
  echo ""
  echo "✓ Gas regression check passed."
  exit 0
else
  EXIT_CODE=$?
  echo ""
  if [ "$UPDATE" = true ]; then
    echo "✓ Baseline updated."
    exit 0
  else
    echo "✗ Gas regression detected! See above for details."
    exit "$EXIT_CODE"
  fi
fi
