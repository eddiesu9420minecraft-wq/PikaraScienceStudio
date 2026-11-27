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
| accel_probe（MPS／MLX／CPU） | 待測 | 見 TESTING.md §7 |
| VideoToolbox h264／hevc 試編碼 | 待測 | 見 TESTING.md §7 |
| WebGL renderer | 待測 | 見 TESTING.md §7 |
| 90 幀渲染 | 待測 | 見 TESTING.md §7 |
| 語音 A/B（chars/s、RTF、峰值記憶體、CER） | 待測 | 不適用（VM 7 GB） |
| ASR | 待測 | — |
| 1080p30 整集 | 待測 | — |
