#!/usr/bin/env bash
# Install CosyVoice 3 for a Pikara project on Linux or macOS (no GUI needed; works over SSH).
#
#   scripts/install-cosyvoice.sh <project dir> [cpu|cu121]     (default: cpu on macOS / no NVIDIA, else cu121)
#
# Same CosyVoice commit, PyTorch version and model as the Windows install, so the voice is the same model with the
# same settings. On CPU the script falls back to fp32 (slower, same quality). It installs:
#   <project>/tools/CosyVoice                 FunAudioLLM/CosyVoice @ COMMIT (+ Matcha-TTS submodule)
#   <project>/tools/CosyVoice/.venv           Python venv (torch 2.3.1, CosyVoice requirements minus GPU/web-UI extras)
#   <project>/tools/CosyVoice/pretrained_models/Fun-CosyVoice3-0.5B   (~4.2 GB; inference files only)
# The narrator reference voice (tools/CosyVoice/reference/reference.wav + .txt) is yours to provide; without one
# this script installs CosyVoice's own Apache-2.0 sample prompt so the pipeline runs (clearly a test voice).
set -euo pipefail
PROJ=$(cd "${1:?project dir}" && pwd)
COSY="$PROJ/tools/CosyVoice"
COMMIT=074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc
TORCH=2.3.1
if [ -n "${2:-}" ]; then DEV=$2
elif [ "$(uname)" = Linux ] && command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null 2>&1; then DEV=cu121
else DEV=cpu; fi
PY=${PYTHON:-}
if [ -z "$PY" ]; then for c in python3.10 python3.11 python3; do command -v $c >/dev/null && PY=$c && break; done; fi
echo "CosyVoice → $COSY  (torch $TORCH/$DEV, $($PY --version))"

if [ ! -d "$COSY/.git" ]; then
  git clone --quiet https://github.com/FunAudioLLM/CosyVoice.git "$COSY"
fi
git -C "$COSY" fetch --quiet origin "$COMMIT" 2>/dev/null || git -C "$COSY" fetch --quiet origin
git -C "$COSY" checkout --quiet "$COMMIT"
git -C "$COSY" submodule update --init --recursive --quiet

[ -x "$COSY/.venv/bin/python" ] || "$PY" -m venv "$COSY/.venv"
V="$COSY/.venv/bin/python"
"$V" -m pip install --quiet -U pip wheel
# openai-whisper 20231117 and pyworld 0.3.4 (CosyVoice pins) build from source and need pkg_resources / numpy at
# build time; setuptools >= 70 dropped pkg_resources from the build backend's reach → build them without isolation
"$V" -m pip install --quiet "setuptools<70" numpy==1.26.4 cython
if [ "$(uname)" = Darwin ]; then
  "$V" -m pip install --quiet "torch==$TORCH" "torchaudio==$TORCH"
else
  "$V" -m pip install --quiet "torch==$TORCH" "torchaudio==$TORCH" --index-url "https://download.pytorch.org/whl/$DEV"
fi
# (after torch, so they never pull a different torch) — their own runtime deps are listed explicitly
"$V" -m pip install --quiet --no-build-isolation --no-deps openai-whisper==20231117 pyworld==0.3.4
"$V" -m pip install --quiet tiktoken numba more-itertools tqdm
# CosyVoice's list minus: CUDA-only (deepspeed, TensorRT, onnxruntime-gpu), the web UI / server (gradio, fastapi,
# uvicorn, grpcio), training (tensorboard) and the torch pins handled above
REQ=$(mktemp)
grep -vE '^(--extra-index-url|deepspeed|tensorrt|onnxruntime|gradio|fastapi|uvicorn|grpcio|tensorboard|torch==|torchaudio==)' "$COSY/requirements.txt" > "$REQ"
ORT=onnxruntime==1.18.0
[ "$DEV" != cpu ] && [ "$(uname)" = Linux ] && ORT=onnxruntime-gpu==1.18.0
# constraints: nothing may replace the torch build chosen above (a newer PyPI torch would be CUDA-only and huge)
CON=$(mktemp)
{ echo "torch==$TORCH"; echo "torchaudio==$TORCH"; echo "numpy==1.26.4"; } > "$CON"
"$V" -m pip install --quiet -c "$CON" -r "$REQ" "$ORT" faster-whisper==1.2.1 opencc-python-reimplemented==0.1.7 "huggingface_hub>=0.30"
rm -f "$REQ" "$CON"

M="$COSY/pretrained_models/Fun-CosyVoice3-0.5B"
if [ ! -f "$M/llm.pt" ]; then
  "$V" - "$M" <<'PYEOF'
import sys
from huggingface_hub import snapshot_download
# inference files only: llm.rl.pt (RL variant), the TensorRT estimator and the batch tokenizer are not used
snapshot_download("FunAudioLLM/Fun-CosyVoice3-0.5B-2512", local_dir=sys.argv[1],
                  ignore_patterns=["llm.rl.pt", "flow.decoder.estimator.fp32.onnx", "speech_tokenizer_v3.batch.onnx"])
PYEOF
fi

R="$COSY/reference"
if [ ! -f "$R/reference.wav" ]; then
  mkdir -p "$R"
  cp "$COSY/asset/zero_shot_prompt.wav" "$R/reference.wav"
  printf '希望你以后能够做的比我还好呦。' > "$R/reference.txt"
  echo "! 沒有旁白參考人聲：暫用 CosyVoice 範例提示音（測試用；正式影片請換成自己的 reference.wav／reference.txt）"
fi
"$V" -c "import torch, torchaudio, onnxruntime, faster_whisper; print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), 'mps', getattr(torch.backends, 'mps', None) is not None and torch.backends.mps.is_available())"
echo "CosyVoice ready: $V"
