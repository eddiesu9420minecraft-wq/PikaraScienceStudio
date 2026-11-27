# 測試

## 1. 規則

- 不在真實資料庫上做任何破壞性測試。每個測試都用獨立資料夾：`PIKARA_STUDIO_DATA=<暫存資料夾>`（Rust 測試內部自動設定；CLI 用 `--data <dir>`）。
- 測試不可關閉、暫停或干擾使用者正在執行的 Studio（以及它正在跑的製作工作）。
- 優先用 headless／CLI 測試；需要視窗的測試在隱藏桌面執行，並事先公告。測試完清掉測試程序。
- 沒有在某平台實測過的功能，不寫成「可用」。

## 2. Windows：判斷是否在封裝容器中執行

Claude 桌面 App 等 MSIX 封裝程式啟動的子程序，`%APPDATA%` 寫入可能被重新導向到 `%LOCALAPPDATA%\Packages\<package>\LocalCache\Roaming`。曾經因此讓真實 `studio.db` 與它的 `-wal` 分家。

- `platform::packaged_container()`（GetCurrentPackageFullName）只能偵測「本程序自己是封裝程序」。**實測（2026-11-27）：從 Claude 桌面 App 的 shell 啟動的 Studio 回傳 `null`，但寫入仍可能被虛擬化** → 不能只靠它。
- 所以規則是：測試一律使用 `PIKARA_STUDIO_DATA` 指向非 AppData 的資料夾（例如 `D:\t\…`），永遠不要讓測試開啟預設資料夾。
- 需要在「真實系統」執行時（例如安裝測試），用 CYW 的 `tools/test/hidden-desktop/run-hidden.mjs` 經 Explorer 啟動以跳出容器。

## 3. 測試清單

| 測試 | 指令 | 內容 |
|---|---|---|
| Rust 單元／整合測試 | `cargo test`（`studio/app/src-tauri`，Windows 請設短的 `CARGO_TARGET_DIR`） | 124 項（Windows，2026-11-27 全數通過）：平台層、真實程序樹暫停／繼續／取消、佇列、DB 遷移（含 6 連線同時遷移競賽、還原保護）、硬體解析（M2／Intel Mac／Rosetta 樣本）、功率模式預算 |
| 硬體報告 | `PikaraScienceStudio --cli hardware` | 唯讀；不開資料庫 |
| 加速器 | `python -I pipeline/scripts/accel_probe.py --out out/accel-probe.json` | CUDA／MPS／MLX／CPU 真實矩陣乘 |
| 編碼器 | `node -e "import('./scripts/hwenc.mjs').then(m=>console.log(JSON.stringify(m.probe({all:true,force:true}),null,2)))"`（`pipeline/`） | 每個候選真實試編碼 + ffprobe |
| WebGL | `node scripts/gpu-check.mjs --force` | Chromium 實際渲染一張探測圖並讀 renderer |
| 語音 A/B | `python scripts/voice_ab.py --candidates <json> --out out/voice_ab` | 見 MACOS.md §3.2 |
| GPU 租約（Python） | 見 §6 | Windows 已實測取得／被占用／釋放 |

## 4. CI（`.github/workflows/cross-platform.yml`）

| Job | 平台 | 內容 |
|---|---|---|
| Core tests | windows-latest、macos-15（arm64）、macos-15-intel、ubuntu-24.04 | `cargo test` + `--cli hardware`（上傳 JSON） |
| Media + AI probes | macOS arm64／x64、Linux | ffmpeg 真實編碼（h264/hevc）、gpu-check、90 幀實際渲染、accel_probe |
| macOS bundle | arm64、x64 | 未簽章 .app/.dmg；檢查 Mach-O 架構、沒有 .exe/.dll、DMG > 2 MB、bundle 內執行 `--cli hardware`、SHA-256 |

GitHub macOS runner 是虛擬機：VideoToolbox、Metal、MPS 的結果**不代表**真機。CI 失敗的項目要到 Mac mini M2 再確認；CI 通過也不能取代真機效能測試。

CI 結果紀錄：見本檔 §7（每次執行後補上）。

## 5. Splash／前端不預載重資源（P7）

Studio 前端是無打包器的 ES module。驗證方法：

```powershell
Select-String -Path studio/app/src/js/*.js, studio/app/src/js/**/*.js -Pattern "three|remotion|webgl|WebGL" 
```

應該沒有任何結果（2026-11-27：0 筆）。Three.js／Remotion 只在製作子程序（Node）中載入；AI 模型只在 Python 子程序中載入。

## 6. GPU 租約（Python，Windows 實測）

```powershell
$env:PIKARA_GPU_LOCK='D:\t\xp-data\gl\gpu.lock'; py -3.11 -c "import sys; sys.path.insert(0,'pipeline/scripts'); import gpu_lock as g; p=g.lock_path(); h=g._open_excl(p); print(g._free(p)); g._close(h); print(g._free(p))"
```

結果：`False`（被持有時無法再取得）→ `True`（釋放後可取得）。

## 7. 實測紀錄

| 日期 | 平台 | 結果 |
|---|---|---|
| 2026-11-27 | CI #1（GitHub，run 45989906162） | 四平台都**能編譯**；Windows 124／124 通過；macOS arm64 115／124、Linux 116／124、macOS x64 失敗 → 找到真正的 Unix 問題：多處把 `/` 轉成 `\`（narration.json、layout、worktree、scaffold 路徑在 Unix 變成含反斜線的檔名）、`mklink /J` 目錄連結、`cmd copy`、暫停測試的環境變數競賽。已在下一個 commit 修正。macOS arm64／x64 `.app`+`.dmg` 建置成功（5.90／6.28 MiB），Mach-O arm64，bundle 內沒有 .exe/.dll，bundle 內執行 `--cli hardware` 成功 |
| 2026-11-27 | CI #1 媒體（macos-15 arm64 VM，macOS 15.8.2） | **h264_videotoolbox、hevc_videotoolbox 實際編碼成功**（469／498 ms）；libx264／libx265 也可用。**MLX Metal 矩陣乘成功**（809 GFLOPS，CPU 190）；torch MPS 在 VM 中不可用（built=True，available=False，GitHub VM 的已知限制）。**Remotion 1080p30 實際渲染 90 幀**（3.2 fps，並行 1，3 核 VM），用 h264_videotoolbox 編碼，ffprobe：1920×1080、30 fps、90 幀。WebGL renderer 字串沒有擷取到（連 SwiftShader 也沒有 → log 擷取問題，不是 GPU 問題；已改 gpu-check 並保存完整 log） |
| 2026-11-27 | CI #1 媒體（macos-15-intel VM，macOS 15.7.9） | VideoToolbox h264／hevc 失敗（-22，VM 沒有硬體編碼）→ 正確退回 libx264／libx265；MPS 不可用 |
| 2026-11-27 | CI #1 媒體（ubuntu-24.04） | NVENC／QSV／VA-API 全部正確判定不可用 → libx264／libx265 |
| 2026-11-27 | CI #2／#3 | macOS arm64、Linux、Windows **全部單元測試通過**（124）；macOS x64 只剩 gpulock 測試的競賽（is_free() 探測與並行測試互相干擾，測試本身的問題，已修）。arm64 VM 的 `system_profiler SPDisplaysDataType` 是空陣列（VM 沒有顯示器）→ Studio 回報 0 張 GPU、AI 用 CPU，不捏造 GPU。WebGL：新的 DOM probe 在 Intel VM 讀到 SwiftShader renderer（機制有效）；三個 VM 的硬體 ANGLE 都不可用（`CVDisplayLinkCreateWithCGDisplay failed`，沒有顯示器）→ **macOS 硬體 WebGL／Metal 必須在真機驗證** |
| 2026-11-27 | Windows 11（Ryzen 7 7445HS + RTX 4050 Laptop 6 GB + Radeon 740M，32 GB） | `cargo test` 124 通過／0 失敗；`--cli hardware`：RTX 4050 discrete 5920 MiB、740M integrated、AI=CUDA、渲染=RTX 4050；平衡模式 渲染 2→4、TTS 批次 4；accel_probe：CUDA 5022 GFLOPS、CPU 403 GFLOPS、MPS／MLX 正確回報不可用 |
