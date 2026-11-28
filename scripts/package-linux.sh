#!/usr/bin/env bash
# Linux release archive: the CLI-only binary + the project template, no GUI code.
#
#   scripts/package-linux.sh <path to pikara-studio binary> <out dir>
#
# Produces <out>/PikaraScienceStudio_<version>_linux-<arch>.tar.gz containing
#   PikaraScienceStudio/PikaraScienceStudio      the CLI (launch path for CYW)
#   PikaraScienceStudio/pipeline-template/       project template (`project new` finds it next to the binary)
#   PikaraScienceStudio/install-cosyvoice.sh     CosyVoice 3 installer for a project (CPU or CUDA)
#   PikaraScienceStudio/README.txt, LICENSE, THIRD_PARTY_NOTICES.md, docs/CLI.md, docs/LINUX.md
# and <out>/SHA256SUMS-linux-<arch>.txt.
set -euo pipefail
BIN=${1:?binary}
OUT=${2:?out dir}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$("$BIN" --json version | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
case "$(uname -m)" in
  x86_64|amd64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  *) ARCH=$(uname -m) ;;
esac
NAME="PikaraScienceStudio_${VERSION}_linux-${ARCH}"
STAGE=$(mktemp -d)
D="$STAGE/PikaraScienceStudio"
mkdir -p "$D/docs"
install -m 0755 "$BIN" "$D/PikaraScienceStudio"
# project template = the tracked files of pipeline/ (no node_modules, renders, tools or voice files)
(cd "$ROOT/pipeline" && git ls-files -z | tar --null -T - -cf -) | (mkdir -p "$D/pipeline-template" && tar -xf - -C "$D/pipeline-template")
cp "$ROOT/LICENSE" "$ROOT/THIRD_PARTY_NOTICES.md" "$D/"
install -m 0755 "$ROOT/scripts/install-cosyvoice.sh" "$D/install-cosyvoice.sh"
cp "$ROOT/docs/CLI.md" "$ROOT/docs/LINUX.md" "$D/docs/"
cat > "$D/README.txt" <<EOF
Pikara Science Studio ${VERSION} — Linux (${ARCH}), command line only.

  ./PikaraScienceStudio --help
  ./PikaraScienceStudio doctor
  ./PikaraScienceStudio project new --dest ~/videos/my-science --title "My Science"
  ./PikaraScienceStudio create --project ~/videos/my-science --topic "..." --wait

No desktop, X11, Wayland or WebView is needed. Rendering uses headless Chromium (Remotion);
voice uses CosyVoice 3 (installed separately, see docs/LINUX.md). docs/CLI.md lists every command and exit code.
EOF
# reproducible-ish archive: fixed owner, sorted names
tar --sort=name --owner=0 --group=0 --numeric-owner -C "$STAGE" -czf "$OUT/$NAME.tar.gz" PikaraScienceStudio
(cd "$OUT" && sha256sum "$NAME.tar.gz" > "SHA256SUMS-linux-${ARCH}.txt")
rm -rf "$STAGE"
echo "$OUT/$NAME.tar.gz"
