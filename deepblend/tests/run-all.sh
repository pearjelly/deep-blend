#!/usr/bin/env bash
# DeepBlend — the complete acceptance suite.
#
# Runs the fast unit/contract suites first, then the end-to-end suites that need
# a real Blender and a real Cordis process. Every suite must pass for the current
# milestone to be considered green.
#
# M0 delivered the minimal vertical slice (capability detection).
# M1 added the batch SceneSpec loop (projects, revisions, patch, preview).
# M2 added the visual loop (multi-view preview, contact sheet, measurements, scoring,
# automated repair, and the three planted-defect fixtures). `e2e/visual-live.e2e.mjs`
# is deliberately NOT part of this run: it spends real model calls and needs an API
# key, so it is run explicitly before a commit that touches the reviewer, the prompt,
# the sheet compositor or the scorer.
#
# Usage: bash deepblend/tests/run-all.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

BLENDER="$ROOT/.tools/Blender.app/Contents/MacOS/Blender"
if [ ! -x "$BLENDER" ]; then
  echo "Blender not found at $BLENDER"
  echo "The Blender suites cannot run. See deepblend/docs/dsh-baseline.md §5."
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

run_suite "Blender capability probe (M0)" \
  node deepblend/tests/blender-integration/probe.e2e.mjs

run_suite "Blender batch SceneSpec + revision loop (M1)" \
  node deepblend/tests/blender-integration/fixture.e2e.mjs

run_suite "Host composition activation" \
  node deepblend/tests/composition/activation.e2e.mjs

run_suite "Agent preset tool plane + degradation path (M0)" \
  node deepblend/tests/composition/tool-plane.e2e.mjs

run_suite "Agent preset M1 tool plane (all seven tools)" \
  node deepblend/tests/composition/tool-plane-m1.e2e.mjs

run_suite "Blender visual loop: multi-view, scoring, repair, handover (M2)" \
  node deepblend/tests/blender-integration/visual-loop.e2e.mjs

run_suite "Agent preset M2 tool plane (all ten tools, image return)" \
  node deepblend/tests/composition/tool-plane-m2.e2e.mjs

echo ""
echo "══════════════════════════════════════════"
if [ "$failed" -eq 0 ]; then
  echo "DeepBlend acceptance suite: ALL SUITES PASSED"
  exit 0
fi
echo "DeepBlend acceptance suite: $failed suite(s) FAILED"
exit 1
