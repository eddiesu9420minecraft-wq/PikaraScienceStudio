#!/usr/bin/env bash
# Headless end-to-end production with the CLI only — no window, no desktop, no DISPLAY:
#   project → script import → (external agent) → voice (CosyVoice) → subtitles/timeline → mix → render → QA → MP4
#
#   scripts/e2e-headless.sh <PikaraScienceStudio CLI> <work dir>
#
# Also tests resume: the worker is interrupted (SIGINT) during the voice stage and started again; finished lines
# must not be re-voiced. Writes <work>/report.json (timings, peak memory, GPU / encoder used, output checks).
set -euo pipefail
# absolute paths without GNU `realpath -m` (macOS has no -m)
abspath() { python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$1"; }
CLI=$(abspath "${1:?cli}")
W=$(abspath "${2:?work dir}")
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA="$W/data"; PROJ="$W/project"; LOG="$W/logs"
mkdir -p "$W" "$LOG"
unset DISPLAY WAYLAND_DISPLAY XDG_SESSION_TYPE || true
S() { "$CLI" --data "$DATA" "$@"; }
J() { "$CLI" --data "$DATA" --json "$@"; }
t0=$(date +%s)

# memory sampler: total RSS of the worker and every process it starts
( while sleep 5; do ps -eo rss=,args= | awk -v w="$W" 'index($0,w) || /render\.mjs|generate_voiceover|remotion|chrome-headless|ffmpeg/ {s+=$1} END {print s}'; done ) > "$LOG/rss.txt" &
SAMPLER=$!
trap 'kill $SAMPLER 2>/dev/null || true' EXIT

[ -d "$PROJ/scripts" ] || J project new --dest "$PROJ" --title "E2E 無頭測試" --template "$ROOT/pipeline" --no-link-tools > "$LOG/project.json"
(cd "$PROJ" && npm ci --no-audit --no-fund > "$LOG/npm.txt" 2>&1)
J doctor --project "$PROJ" > "$LOG/doctor.json" || echo "doctor reported problems (see logs/doctor.json)"
J hardware > "$LOG/hardware.json" 2>/dev/null || S hardware > "$LOG/hardware.json"

ID=$(J create --project "$PROJ" --topic "為什麼天空是藍色的" --script-file "$ROOT/scripts/e2e-script.md" \
      --style generic --agent external --language zh-TW --minutes 0.5 \
      --no-youtube --no-thumbnail --no-publish-info --no-visual-review | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "production $ID"

# the CLI itself must be the background job (not a function / subshell), so the signal and `wait` reach it
start_worker() { "$CLI" --data "$DATA" run --stay --timeout 7200 >> "$LOG/worker.txt" 2>&1 & WPID=$!; }
start_worker
interrupted=0
deadline=$(( $(date +%s) + 7200 ))
while :; do
  st=$(J status "$ID" | python3 -c 'import json,sys; p=json.load(sys.stdin)["production"]; j=p.get("job") or {}; print(p["status"], p["stage"], j.get("kind") or "-", j.get("progress") or 0)')
  read -r status stage kind prog <<<"$st"
  echo "$(date +%T) $status $stage $kind $prog"
  case $status in
    waiting_agent)
      # the "external agent": the script was imported verbatim, nothing to rewrite → report done
      J agent task "$ID" > "$LOG/agent-task-$stage.json"
      J agent done "$ID" --note "CI agent: script imported verbatim" > /dev/null ;;
    succeeded) break ;;
    failed|canceled|needs_merge)
      S status "$ID"; S logs "$ID" --tail 200 > "$LOG/production-log.txt"; exit 7 ;;
  esac
  # resume test: interrupt once, mid-voice, after at least one line is done
  if [ $interrupted = 0 ] && [ "$kind" = voiceover_tw ] && python3 -c "import sys; sys.exit(0 if float('$prog') >= 0.3 else 1)"; then
    echo "--- SIGINT to the worker during voice ($prog)"
    # voice files live in the production's worktree; remember which lines were already finished
    find -H "$PROJ" -path '*voiceover_cosy*' -name '*.mp3' -not -path '*/_test/*' 2>/dev/null | sort > "$LOG/voice-before-interrupt.txt" || true
    date +%s > "$LOG/interrupt-ts.txt"
    kill -INT "$WPID"; set +e; wait "$WPID"; code=$?; set -e
    echo "worker exit $code (130 = interrupted, resumable)" | tee -a "$LOG/worker.txt"
    [ $code = 130 ] || { echo "worker did not stop cleanly"; exit 1; }
    interrupted=1
    start_worker
  fi
  [ "$(date +%s)" -lt "$deadline" ] || { echo timeout; exit 6; }
  sleep 15
done
kill -INT "$WPID" 2>/dev/null || true; wait "$WPID" 2>/dev/null || true
S status "$ID" | tee "$LOG/final-status.txt"
S logs "$ID" --tail 400 > "$LOG/production-log.txt"

MP4=$(J status "$ID" | python3 -c 'import json,sys,os; p=json.load(sys.stdin)["production"]; print(next((o for o in p["outputs"] if o.endswith(".mp4")), ""))')
case $MP4 in /*) ;; *) MP4="$PROJ/$MP4" ;; esac
[ -f "$MP4" ] || { echo "no MP4 in outputs"; exit 1; }
ffprobe -v error -show_entries format=duration:stream=codec_type,codec_name,width,height,r_frame_rate -of json "$MP4" > "$LOG/ffprobe.json"
mkdir -p "$W/frames"
for t in 1 5 10 15; do ffmpeg -v error -y -ss $t -i "$MP4" -frames:v 1 "$W/frames/t$t.png" || true; done
cp "$MP4" "$W/output.mp4"
python3 - "$W" "$LOG" "$t0" "$interrupted" <<'PYEOF'
import json, sys, time, pathlib
w, log, t0, intr = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), int(sys.argv[3]), sys.argv[4] == "1"
pr = json.load(open(log / "ffprobe.json"))
streams = {s["codec_type"]: s for s in pr["streams"]}
assert "video" in streams and "audio" in streams, "MP4 needs video and audio"
dur = float(pr["format"]["duration"])
assert dur > 5, f"too short: {dur}"
rss = [int(x) for x in (log / "rss.txt").read_text().split() if x.isdigit()]
hw = {}
try:
    hw = json.load(open(log / "hardware.json"))
except Exception:
    pass
kept = None
before = (log / "voice-before-interrupt.txt")
if intr and before.exists():
    ts = int((log / "interrupt-ts.txt").read_text().strip())
    files = [pathlib.Path(x) for x in before.read_text().splitlines() if x.strip()]
    # a line finished before the interruption must not have been voiced again after the restart
    redone = [str(f) for f in files if f.exists() and f.stat().st_mtime > ts + 1]
    kept = {"finishedBeforeInterrupt": len(files), "revoicedAfterRestart": len(redone)}
    assert not redone, f"finished lines were re-voiced after resume: {redone[:3]}"
rep = {"ok": True, "durationSec": dur, "resume": kept, "video": streams["video"], "audio": streams["audio"], "wallSec": int(time.time()) - t0,
       "peakRssMiB": (max(rss) // 1024) if rss else None, "resumeTested": intr,
       "gpus": [g.get("name") for g in hw.get("snapshot", {}).get("gpus", [])], "assignment": hw.get("assignment")}
json.dump(rep, open(w / "report.json", "w"), ensure_ascii=False, indent=2)
print(json.dumps(rep, ensure_ascii=False, indent=2))
PYEOF
