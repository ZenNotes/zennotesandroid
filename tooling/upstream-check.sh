#!/bin/sh
# Verify and typecheck against the exact ZenNotes source used by release builds.
set -eu

DIR="$(cd "$(dirname "$0")/.." && pwd)"
sh "$DIR/tooling/prepare-zennotes.sh"

PIN="$(tr -d '[:space:]' < "$DIR/.zennotes-commit")"
ACTUAL="$(git -C "$DIR/.zennotes-source" rev-parse HEAD)"
if [ "$PIN" != "$ACTUAL" ]; then
  echo "Source mismatch: expected $PIN, found $ACTUAL" >&2
  exit 1
fi

echo "Typechecking mobile against pinned ZenNotes source $PIN..."
cd "$DIR"
npx tsc --noEmit
echo "OK: pinned bridge contract satisfied."
