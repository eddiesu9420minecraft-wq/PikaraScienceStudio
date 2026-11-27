# 效能紀錄

只記錄實測數字；沒有量到的欄位寫「待測」，不填估計值。

## Windows（開發機：Ryzen 7 7445HS、RTX 4050 Laptop 6 GB、Radeon 740M、32 GB）

| 項目 | 結果 | 日期／方法 |
|---|---|---|
| fp32 矩陣乘 1024² | CUDA 5022 GFLOPS；CPU（numpy）403 GFLOPS | 2026-11-27，`accel_probe.py --size 1024`（CosyVoice venv，torch 2.3.1+cu121） |
| 功率模式預算 | 省電：渲染 1→2、TTS 批次 1、6 執行緒、10349 MiB；平衡：2→4、4、9、16752 MiB；高效能：3→6、4、10、20940 MiB | `--cli hardware` |
| 冷／熱啟動、配音 chars/s、ASR、渲染 FPS、編碼速度 | 待測（P12；既有 v0.3 數據見 repo 根目錄 TEST_REPORT.md） | — |

## macOS

| 項目 | Mac mini M2 | GitHub macos-15（VM，僅供參考） |
|---|---|---|
| accel_probe（MPS／MLX／CPU，1024² fp32） | 待測 | MLX 809 GFLOPS；CPU 190 GFLOPS；MPS 不可用（VM） |
| VideoToolbox h264／hevc 試編碼（1 s 720p60） | 待測 | 469 ms／498 ms（libx264 1272 ms、libx265 5258 ms） |
| WebGL renderer | 待測 | 未擷取（log 問題，已修，待下一次 CI） |
| 90 幀 1080p30 渲染（EP01-30fps） | 待測 | 28 s，3.2 fps，並行 1，h264_videotoolbox |
| 語音 A/B（chars/s、RTF、峰值記憶體、CER） | 待測 | 不適用（VM 7 GB） |
| ASR | 待測 | — |
| 1080p30 整集 | 待測 | — |
