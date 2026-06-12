#!/usr/bin/env bash
# Bible IU iOS sync helper.
#
# Usage:
#   ./scripts/cap-sync.sh              # build + sync (default)
#   ./scripts/cap-sync.sh --open       # build + sync + open in Xcode
#   ./scripts/cap-sync.sh --no-build   # sync only (faster, if dist/ is already current)
#
# Run from the `frontend` directory (where capacitor.config.ts lives).
set -euo pipefail

cd "$(dirname "$0")/.."

DO_BUILD=true
OPEN_XCODE=false

for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=false ;;
    --open) OPEN_XCODE=true ;;
    -h|--help)
      sed -n '2,9p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

if [ "$DO_BUILD" = true ]; then
  echo "==> npm run build"
  npm run build
fi

echo "==> npx cap sync ios"
npx cap sync ios

if [ "$OPEN_XCODE" = true ]; then
  echo "==> opening Xcode"
  npx cap open ios
fi

echo "done."
