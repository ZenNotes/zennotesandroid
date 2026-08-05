#!/bin/sh
# Report what changed in the zennotes repo since this app's last `npm run sync`,
# then typecheck against the current source. Two failure modes matter:
#   1. Bridge-contract additions — tsc fails until mobile-bridge implements them.
#   2. New vault semantics/settings — look for packages/bridge-contract, vault
#      settings, or apps/desktop/src/main/vault.ts in the commit list below and
#      mirror them (mobile keeps its own copy of vault + settings handling).
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
ZEN="$DIR/../../opensource/zennotes"
STAMP="$DIR/.zennotes-commit"

if [ ! -f "$STAMP" ]; then
  echo "No .zennotes-commit stamp yet — run 'npm run sync' once to create it."
else
  SINCE="$(cat "$STAMP")"
  echo "zennotes changes since last mobile sync ($SINCE):"
  echo "--------------------------------------------------------------"
  git -C "$ZEN" log --oneline "$SINCE"..HEAD -- packages apps/desktop/src/main || true
  echo "--------------------------------------------------------------"
  echo "Contract/vault files touched (need manual mirroring if any):"
  git -C "$ZEN" diff --stat "$SINCE"..HEAD -- packages/bridge-contract apps/desktop/src/main/vault.ts | tail -5 || true
fi

echo
echo "Typechecking mobile against current zennotes source..."
cd "$DIR" && npx tsc --noEmit && echo "OK: bridge contract satisfied."
