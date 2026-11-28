#!/usr/bin/env bash
# macOS release files from a `tauri build --bundles app,dmg` output (one architecture per run).
#
#   scripts/package-macos.sh <tauri bundle dir> <out dir>
#
# Produces, with <arch> = aarch64 (Apple Silicon) or x64 (Intel), matching the Windows `_x64` naming:
#   Pikara.Science.Studio_<version>_<arch>.dmg          disk image (drag to Applications)
#   Pikara.Science.Studio_<version>_<arch>.app.tar.gz   the .app for installers / updaters (CYW)
#   SHA256SUMS-macos-<arch>.txt
# Not code-signed or notarized unless the release workflow has Apple credentials (it never fakes them).
set -euo pipefail
B=${1:?bundle dir}
OUT=${2:?out dir}
APP=$(ls -d "$B"/macos/*.app | head -1)
BIN="$APP/Contents/MacOS/PikaraScienceStudio"
VERSION=$("$BIN" --json version | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
case "$(lipo -archs "$BIN")" in
  arm64) ARCH=aarch64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "unexpected architectures: $(lipo -archs "$BIN")" >&2; exit 1 ;;
esac
NAME="Pikara.Science.Studio_${VERSION}_${ARCH}"
mkdir -p "$OUT"
cp "$(ls "$B"/dmg/*.dmg | head -1)" "$OUT/$NAME.dmg"
# keep the .app's symlinks and permissions; the archive root is the .app folder
tar -C "$(dirname "$APP")" -czf "$OUT/$NAME.app.tar.gz" "$(basename "$APP")"
(cd "$OUT" && shasum -a 256 "$NAME.dmg" "$NAME.app.tar.gz" > "SHA256SUMS-macos-${ARCH}.txt")
ls -la "$OUT"
