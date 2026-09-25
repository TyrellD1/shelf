#!/usr/bin/env bash
# Installs the latest Shelf CLI release into ~/.local/bin (or SHELF_INSTALL_DIR).
#
#   curl -fsSL https://raw.githubusercontent.com/TyrellD1/shelf/main/install.sh | bash
set -euo pipefail

REPO="${SHELF_REPO:-TyrellD1/shelf}"
BIN_DIR="${SHELF_INSTALL_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/shelf"

if ! command -v node >/dev/null 2>&1; then
  echo "shelf needs Node.js 20 or newer (https://nodejs.org)." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "shelf needs Node.js 20 or newer (found $(node -v))." >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching the latest release of $REPO…"
API="https://api.github.com/repos/$REPO/releases/latest"
RELEASE="$(curl -fsSL "$API")" || {
  echo "Could not read the latest release from $REPO." >&2
  exit 1
}

ASSET_URL="$(printf '%s' "$RELEASE" | grep -o '"browser_download_url": *"[^"]*shelf\.cjs"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
SUMS_URL="$(printf '%s' "$RELEASE" | grep -o '"browser_download_url": *"[^"]*SHA256SUMS"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
TAG="$(printf '%s' "$RELEASE" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\(v[^"]*\)"/\1/')"

if [ -z "$ASSET_URL" ]; then
  echo "No shelf.cjs asset in the latest release." >&2
  exit 1
fi

curl -fsSL "$ASSET_URL" -o "$TMP/shelf.cjs"

if [ -n "$SUMS_URL" ]; then
  curl -fsSL "$SUMS_URL" -o "$TMP/SHA256SUMS"
  EXPECTED="$(grep 'shelf.cjs' "$TMP/SHA256SUMS" | awk '{print $1}' | head -1)"
  if command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$TMP/shelf.cjs" | awk '{print $1}')"
  else
    ACTUAL="$(sha256sum "$TMP/shelf.cjs" | awk '{print $1}')"
  fi
  if [ -n "$EXPECTED" ] && [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "Checksum mismatch — install aborted." >&2
    exit 1
  fi
fi

mkdir -p "$BIN_DIR"
chmod +x "$TMP/shelf.cjs"
mv "$TMP/shelf.cjs" "$TARGET"

echo "Installed $TAG to $TARGET"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add $BIN_DIR to your PATH to run \`shelf\`." ;;
esac

cat <<'NEXT'

Next:
  shelf setup                 # authorize this machine in the browser
  shelf write ./report.html   # write something
  shelf open ./report.html    # open it in the desktop app

Agents can read the skill at skills/shelf/SKILL.md.
NEXT
