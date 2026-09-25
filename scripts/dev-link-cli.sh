#!/usr/bin/env bash
# Build the CLI bundle and point ~/.local/bin/shelf at it, so a checkout works
# as the installed command. Release installs (install.sh) replace this symlink.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${SHELF_BIN_DIR:-$HOME/.local/bin}"

cd "$ROOT"
npm run build -w cli
chmod +x cli/dist/shelf.cjs
mkdir -p "$BIN_DIR"
ln -sfn "$ROOT/cli/dist/shelf.cjs" "$BIN_DIR/shelf"
echo "linked $BIN_DIR/shelf -> $ROOT/cli/dist/shelf.cjs"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: $BIN_DIR is not on your PATH" ;;
esac
"$BIN_DIR/shelf" version
