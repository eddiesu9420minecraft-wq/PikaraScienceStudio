#!/usr/bin/env bash
# 最終交付：配音完成後一次跑完 時間軸 → 混音 → 字幕 → 配音稿 → 1080p30 渲染（NVENC，可續傳）→ 品質檢查
set -e
cd "$(dirname "$0")/.."
export PATH="/c/Program Files/nodejs:$PATH"
echo "[$(date +%T)] 1/5 時間軸（真實音檔）"
py -3.11 scripts/build_timeline.py --seq ep01
cp out/subtitles/ep01.srt EP01.srt
echo "[$(date +%T)] 2/5 混音（背景執行，與渲染並行；編碼前一定完成）"
rm -f out/mix_final.done
( py -3.11 scripts/mix_audio.py --seq ep01 > out/mix_final.log 2>&1; py -3.11 scripts/export_voiceover_md.py >> out/mix_final.log 2>&1; touch out/mix_final.done ) &
MIXPID=$!
echo "[$(date +%T)] 3/5 渲染 1080p30（GPU / NVENC）"
# 先只渲染幀（--frames 全範圍），確認混音完成後再編碼：render.mjs 在編碼前讀取混音檔
node scripts/render.mjs gpu --comp EP01-30fps --out EP01_Final.mp4 --skip-check --start-concurrency 6 --wait-file out/mix_final.done
echo "[$(date +%T)] 4/5 品質檢查"
py -3.11 scripts/qa_video.py EP01_Final.mp4 --seq ep01 | head -40
echo "[$(date +%T)] 5/5 完成"
