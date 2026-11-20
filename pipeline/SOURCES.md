# 資料來源（SOURCES）

查閱日期：2026-11-19。配音稿與畫面中的技術敘述以下列資料為準；簡化示意處另行標註。

## llama.cpp

| 來源 | 用於 |
|---|---|
| llama.cpp README — https://github.com/ggml-org/llama.cpp | 專案定位為「LLM inference in C/C++」，目標是以最少設定在多種硬體上推理；附帶 CLI、OpenAI 相容的 server 等工具 → 旁白「推理引擎加上一組相關工具，不是某個特定模型」 |
| llama.cpp build 文件 — https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md | 後端：CPU（含 BLAS）、Metal、CUDA、HIP、Vulkan、SYCL 等；`-ngl` / `--n-gpu-layers` 控制放進 GPU 的層數，`-ngl 0` 時 GPU 仍可能加速部分計算 → 旁白「一部分、甚至全部的模型層放進 VRAM」 |

## GGUF 與量化

| 來源 | 用於 |
|---|---|
| GGUF 規格 — https://github.com/ggml-org/ggml/blob/master/docs/gguf.md | GGUF 是給 GGML 系推理器使用的**檔案格式**；結構為 header（magic `GGUF`、版本）→ metadata key-value（`general.architecture`、`tokenizer.ggml.*` 等）→ tensor info → 對齊後的 tensor data → 旁白「把權重、模型結構設定和分詞器資訊打包在同一個檔案；GGUF 本身不是模型」 |
| Hugging Face Hub GGUF 文件 — https://huggingface.co/docs/hub/gguf | 量化型別表：Q8_0 每塊 32 個權重、`w = q × block_scale`；Q4_K 約 4.5 bits/weight、Q5_K 約 5.5、Q6_K 約 6.5625 → 旁白「Q8 分組共用縮放係數」「Q4 每個權重大約 4 到 5 位元」 |

| llama.cpp quantize 文件 — https://github.com/ggml-org/llama.cpp/blob/master/tools/quantize/README.md | `--pure` 選項說明為「停用 k-quant 混合、所有張量量化成同一型別」→ 預設的 Q4_K_M 是**混合型別**；同文件的 Llama-3.1-8B 表格列出 Q4_K_M 約 4.89 bits/weight → 旁白「大部分權重用 4 位元左右，比較敏感的部分保留更多位元」 |
| IEEE 754 半精度／單精度 | FP32 = 1 符號 + 8 指數 + 23 尾數；FP16 = 1 + 5 + 10（第四幕位元示意） |

## 硬體

| 來源 | 用於 |
|---|---|
| NVIDIA GeForce RTX 40 系列筆電頁面 — https://www.nvidia.com/en-us/geforce/laptops/40-series/ | RTX 4050 Laptop GPU：6 GB GDDR6（官方頁未列匯流排寬度，因此片中不標示） |
| 本機 `nvidia-smi` | 製作用電腦確實為 RTX 4050 Laptop GPU、6141 MiB VRAM；第五幕只引用「Ryzen 7、32 GB 系統記憶體、RTX 4050 Laptop 6 GB」這些規格，**沒有任何推理速度實測數字** |

## 計算說明（非引用、可自行驗算）

- 4B 模型 × 16 位元（2 bytes）= 4×10⁹ × 2 B = 8×10⁹ B ≈ 8 GB（十進位 GB）。
- 8B 模型理論權重大小（參數量 × 位元數 ÷ 8）：FP32 ≈ 32 GB、FP16 ≈ 16 GB、INT8 ≈ 8 GB、4 位元 ≈ 4 GB；70B × 4 位元 ≈ 35 GB。片中標示為「理論值」，並說明實際 GGUF 檔案會因縮放係數與高精度層而稍大。
- 生成階段（decode）每產生一個 token 都要讀取幾乎全部權重，因此在單一使用者情境下通常受記憶體頻寬限制；片中只做定性說明，不給任何速度數字。
- 「參數」指權重等可學習數值，數量與「神經元」不同 → 旁白明確區分。

## 本片刻意簡化之處（避免誤解）

- 晶片表面的 24×24 方格是**矩陣 × 向量**的示意，不代表實際 GPU 晶片佈局；畫面標示「示意圖，非實際晶片佈局」。
- 乘加波前「每一列同時累加」表達列與列之間可平行；實際 GPU 以大量運算單元分塊平行處理，非逐欄掃描。
- 顯示卡模型為原創、通用造型，不代表任何特定廠牌或型號；不顯示任何效能數字或規格。
- 「運算的主力會交給 GPU」：指模型層放進 VRAM（GPU offload）時；分詞等步驟仍在 CPU 端執行。

## 工具與參考實作

| 專案 | 授權 | 用法 |
|---|---|---|
| Remotion 4 — https://www.remotion.dev | Remotion License（個人／小團隊免費，公司規模達門檻需購買） | 影片框架 |
| edge-tts 7.3.1 — https://github.com/rany2/edge-tts | LGPL-3.0（以套件呼叫，未修改） | 旁白 TTS，`zh-TW-YunJheNeural` |
| heygen-com/hyperframes `duck.mjs` | Apache-2.0 | 參考其「說話區段合併 → ducking 關鍵影格」作法，於 `scripts/mix_audio.py` 以 Python 改寫（未複製程式碼） |
| givemotion/givemotion `src/ffmpeg.js` | MIT | 參考其「靜音底軌 + amix normalize=0 + alimiter 延遲補償」混音鏈，於 `scripts/mix_audio.py` 改寫 |
| Chupps1110111/narrated-video-toolkit | MIT | 評估後未採用程式碼（以空白斷詞，不支援中文）；錨點 API 概念與本專案相同 |
| 0x68616F4C/auto-popsci | **無授權條款** | 未使用任何內容 |
