#!/bin/sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIN_FILE="$ROOT/.zennotes-commit"
SOURCE_DIR="$ROOT/.zennotes-source"
REMOTE="${ZENNOTES_SOURCE_REMOTE:-https://github.com/ZenNotes/zennotes.git}"

if [ ! -f "$PIN_FILE" ]; then
  echo "Missing .zennotes-commit source pin." >&2
  exit 1
fi

PIN="$(tr -d '[:space:]' < "$PIN_FILE")"
case "$PIN" in
  *[!0-9a-f]*|'')
    echo ".zennotes-commit must contain a full lowercase Git commit SHA." >&2
    exit 1
    ;;
esac
if [ "${#PIN}" -ne 40 ]; then
  echo ".zennotes-commit must contain a full 40-character Git commit SHA." >&2
  exit 1
fi

if [ ! -d "$SOURCE_DIR/.git" ]; then
  if [ -e "$SOURCE_DIR" ]; then
    echo "$SOURCE_DIR exists but is not a Git checkout; remove or rename it." >&2
    exit 1
  fi
  git clone --filter=blob:none "$REMOTE" "$SOURCE_DIR"
fi

if [ -n "$(git -C "$SOURCE_DIR" status --porcelain)" ]; then
  echo "$SOURCE_DIR has local changes; refusing to replace reproducible source." >&2
  exit 1
fi

if ! git -C "$SOURCE_DIR" cat-file -e "$PIN^{commit}" 2>/dev/null; then
  git -C "$SOURCE_DIR" fetch --depth=1 origin "$PIN"
fi

git -C "$SOURCE_DIR" checkout --quiet --detach "$PIN"
ACTUAL="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
if [ "$ACTUAL" != "$PIN" ]; then
  echo "Expected ZenNotes source $PIN but checked out $ACTUAL." >&2
  exit 1
fi

DEPENDENCY_MARKER="$SOURCE_DIR/node_modules/.zennotes-source-commit"
INSTALLED_PIN=""
if [ -f "$DEPENDENCY_MARKER" ]; then
  INSTALLED_PIN="$(tr -d '[:space:]' < "$DEPENDENCY_MARKER")"
fi
if [ "$INSTALLED_PIN" != "$PIN" ]; then
  echo "Installing dependencies for pinned ZenNotes source..."
  npm --prefix "$SOURCE_DIR" ci --ignore-scripts --no-audit --no-fund
  printf '%s\n' "$PIN" > "$DEPENDENCY_MARKER"
fi

echo "ZenNotes source ready at $ACTUAL"
