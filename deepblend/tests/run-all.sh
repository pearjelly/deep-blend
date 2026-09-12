#!/usr/bin/env bash
# DeepBlend M0 — the complete acceptance suite.
#
# Runs the fast unit/contract suites first, then the three end-to-end suites that
# need a real Blender and a real Cordis process. Every suite must pass for M0 to
# be considered green.
#
# Usage: bash deepblend/tests/run-all.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

BLENDER="$ROOT/.tools/Blender.app/Contents/MacOS/Blender"
if [ ! -x "$BLENDER" ]; then
  echo "Blender not found at $BLENDER"
  echo "M0's Blender suites cannot run. See deepblend/docs/dsh-baseline.md §5."
  exit 2
fi

failed=0

run_suite() {
  local label="$1"; shift
  echo ""
  echo "══════ $label ══════"
  if "$@"; then
    echo "✓ $label"
  else
    echo "✗ $label"
    failed=$((failed + 1))
  fi
}

run_suite "unit + contract (no Blender required)" \
  node deepblend/tests/run.mjs

run_suite "Blender integration (real binary, real Cordis context)" \
  node deepblend/tests/blender-integration/probe.e2e.mjs

run_suite "Host composition activation" \
  node deepblend/tests/composition/activation.e2e.mjs

run_suite "Agent preset tool plane + degradation path" \
  node deepblend/tests/composition/tool-plane.e2e.mjs

echo ""
echo "══════════════════════════════════════════"
if [ "$failed" -eq 0 ]; then
  echo "M0 acceptance suite: ALL SUITES PASSED"
  exit 0
fi
echo "M0 acceptance suite: $failed suite(s) FAILED"
exit 1
