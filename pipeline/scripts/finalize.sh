#!/usr/bin/env bash
# 最終交付：配音完成後一次跑完 時間軸 → 混音 → 字幕 → 配音稿 → 1080p30 渲染（NVENC，可續傳）→ 品質檢查
#   bash scripts/finalize.sh            # ep01（預設）
#   bash scripts/finalize.sh ep02       # 其他集數：輸出 EP02_Final.mp4、EP02.srt
set -e
cd "$(dirname "$0")/.."
export PATH="/c/Program Files/nodejs:$PATH"
SEQ="${1:-ep01}"
if ! [[ "$SEQ" =~ ^ep[0-9]{2,3}$ ]]; then
  echo "集數 id 格式不正確：$SEQ（例：ep02）" >&2
  exit 1
fi
EP="${SEQ^^}"
echo "[$(date +%T)] 1/5 時間軸（真實音檔）$SEQ"
py -3.11 scripts/build_timeline.py --seq "$SEQ"
cp "out/subtitles/$SEQ.srt" "$EP.srt"
echo "[$(date +%T)] 2/5 混音（背景執行，與渲染並行；編碼前一定完成）"
rm -f "out/mix_final_$SEQ.done"
( py -3.11 scripts/mix_audio.py --seq "$SEQ" > "out/mix_final_$SEQ.log" 2>&1; [ "$SEQ" = ep01 ] && py -3.11 scripts/export_voiceover_md.py >> "out/mix_final_$SEQ.log" 2>&1; touch "out/mix_final_$SEQ.done" ) &
echo "[$(date +%T)] 3/5 渲染 1080p30（GPU / NVENC）"
# 先只渲染幀（--frames 全範圍），確認混音完成後再編碼：render.mjs 在編碼前讀取混音檔
node scripts/render.mjs gpu --comp "$EP-30fps" --out "${EP}_Final.mp4" --skip-check --start-concurrency 6 --wait-file "out/mix_final_$SEQ.done"
echo "[$(date +%T)] 4/5 品質檢查"
py -3.11 scripts/qa_video.py "${EP}_Final.mp4" --seq "$SEQ" | head -40
echo "[$(date +%T)] 5/5 完成"
