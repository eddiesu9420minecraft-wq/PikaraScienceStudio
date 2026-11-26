# 硬體偵測、裝置分配與 GPU 資源排程（v0.3）

## 1. 模組

| 模組 | 檔案 | 責任 |
|---|---|---|
| HardwareManager | `src-tauri/src/hardware/native.rs`、`manager.rs` | 以 Windows 原生 API 偵測 GPU：DXGI 1.6（名稱、PCI 廠商／裝置／子系統 ID、LUID、專用 VRAM、專用／共享系統記憶體、軟體旗標、驅動版本、連接的螢幕數、Windows 省電／高效能排序）、Direct3D 12（實際建立裝置、最高 Feature Level、**UMA＝內顯**）、CUDA 驅動 API（`nvcuda.dll`：裝置、記憶體、Compute Capability、**以 LUID 對應到 DXGI 轉接器**）、裝置管理員（被停用／錯誤代碼、可熱插拔＝外接）。偵測在獨立執行緒、有時間上限；失敗時回傳安全的軟體／CPU 模式，Studio 照常啟動。 |
| DeviceSelector | `hardware/selector.rs` | 依偵測結果與設定決定四個角色的裝置：介面（WebView2）、影片渲染（Remotion／Three.js 的 Chromium）、AI 推理（CosyVoice／Whisper）、硬體編碼器；每個決定附原因，手動設定無法使用時自動回退並說明。設定頁的選項也由它產生（只列出偵測到、可用、實測沒失敗的裝置）。 |
| ResourceScheduler | `gpulock.rs`、`scripts/gpu_lock.py` | 全機租約：測試／Benchmark／截圖取得「全域租約」，Studio 的 GPU 工作取得「各 GPU 租約」。不同 GPU 上的工作可同時進行，同一張 GPU 輪流；只用 CPU 的重工作共用 `cpu-heavy` 租約。持有者當機時 Windows 自動釋放。 |
| 驗證 | `hardware/usage.rs` | Windows「GPU Engine」「GPU Process Memory」效能計數器（工作管理員的資料來源，以英文計數器名稱讀取，中文 Windows 也可用）：每個程序在每張 GPU 上的各引擎使用率與專用記憶體，依程序樹分成介面／渲染／AI／編碼。 |

GPU 判斷**不依賴 nvidia-smi**，也**不看名稱猜類型**：內顯／獨顯由 D3D12 回報的 UMA 決定；D3D12 不可用時才用專用記憶體與 Windows 省電排序推測，並標示「推測」。

## 2. 自動分配規則

| 硬體 | 介面 | 渲染 | AI | 編碼 |
|---|---|---|---|---|
| 單一 GPU | 該 GPU | 該 GPU | 有 CUDA → 該 GPU，否則 CPU | 該 GPU 的家族（實測可用時） |
| 內顯＋獨顯 | 內顯 | 專用記憶體最多的獨顯 | CUDA 裝置 | 渲染 GPU 的家族 |
| 兩張以上獨顯 | 渲染沒用到的那張 | 與 AI 不同的一張（≥ 2 GiB），兩者可同時進行 | 記憶體最多的 CUDA 裝置 | 渲染 GPU 的家族 |
| 沒有 CUDA（AMD／Intel） | 同上 | 同上 | CPU（本專案的 TTS 沒有 DirectML／ROCm 路徑） | AMF／Quick Sync |
| 沒有可用 GPU | 軟體繪製（WARP） | CPU（SwiftShader） | CPU | libx264 |
| 偵測失敗／GPU 被停用或移除 | 回退到上一列，介面與工作照常運作，原因顯示在設定與診斷頁 | | | |

套用方式（都只影響 Studio 自己啟動的程序，**不修改 Windows 圖形設定、登錄、驅動，也不停用任何 GPU 或硬體加速**）：
- 介面：Studio 啟動、建立 WebView2 之前設定本程序的 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=… --use-adapter-luid=<high>,<low>`。改介面 GPU 需重新啟動 Studio。
- 渲染：`render.mjs`／`gpu-check.mjs` 對 Remotion 傳 `--chromium-flags={"use-adapter-luid":"<high>,<low>"}`；CPU 時改用 SwiftShader。
- AI：`CUDA_VISIBLE_DEVICES=<CUDA 索引>`；空白＝不使用 CUDA（腳本走 CPU）。
- 編碼器：`PIKARA_ENCODER`；GPU 資源上限：`PIKARA_VRAM_CAP`（渲染 GPU 專用記憶體 × 百分比）。

## 3. 實機驗證（AMD Radeon 740M＋NVIDIA RTX 4050 Laptop 6 GB）

偵測結果（`--cli hw-info`）：RTX 4050：獨顯（D3D12 非 UMA）、5920 MiB、驅動 32.0.16.2101、D3D12 12_2、CUDA 0（8.9）、**接著螢幕**；Radeon 740M：內顯（D3D12 UMA）、420 MiB、驅動 32.0.13058.2、D3D12 12_2、沒有接螢幕；另有 Microsoft Basic Render Driver（軟體）。
RTX 4050 的裝置移除原則是 2（筆電獨顯為了省電可「有序移除」），所以外接判斷只看 3（可意外移除，Thunderbolt／USB4 外接盒）。

### 渲染（Remotion Chromium）— WebGL renderer 字串（`scripts/exp_adapter_select.py`）
| 設定 | ANGLE 實際使用 |
|---|---|
| 不指定 | NVIDIA GeForce RTX 4050 Laptop GPU |
| `use-adapter-luid=0,75596`（740M） | **AMD Radeon 740M Graphics** |
| `use-adapter-luid=0,91465`（4050） | **NVIDIA GeForce RTX 4050 Laptop GPU** |
| 十六進位寫法 | WebGL 無法初始化 → 不使用 |

### 介面（WebView2）— GPU Engine 計數器，只算這個 Studio 視窗的 msedgewebview2 程序（`scripts/exp_ui_gpu.py`，導覽測試持續切換畫面）
| 模式 | RTX 4050 | Radeon 740M |
|---|---|---|
| WebView2 預設（不指定） | 3D 0.4–1.1%，專用 138–159 MiB | 未使用 |
| 自動（→ 內顯） | 3D 0.4–4.8%，專用 **24 MiB** | 3D 0.1–1.5%，專用 159–204 MiB |
| 內顯 | 3D 0.9–3.5%，專用 **24 MiB** | 3D 0.3–1.4%，專用 170–196 MiB |
| 獨顯 | 3D 0.3–0.9%，專用 122–156 MiB | 未使用 |

結論（誠實版）：
- **切換確實生效**：介面的繪製與大部分 GPU 記憶體移到 740M，4050 上介面佔用的專用記憶體從約 150 MiB 降到 24 MiB。
- **4050 上仍有少量介面負載**：這台筆電的螢幕接在 RTX 4050（DXGI：4050 有 1 個輸出、740M 沒有），桌面由 4050 合成，在 740M 畫好的介面要跨 GPU 複製到 4050 才能顯示。這是硬體接線（MUX／獨顯直連模式）決定的，Studio 不會去改；若在廠商工具切換為混合模式（螢幕接內顯），這部分負載會消失。
- 介面同時運作時對渲染速度的實際影響，見 TEST_REPORT.md 的 Benchmark B3。

### CosyVoice／Whisper／FFmpeg
由 Benchmark 與端到端測試期間的計數器確認（TEST_REPORT.md）。

## 4. 相容性測試（Mock，**非實機**）

`hardware/selector.rs` 測試以 Mock 的 DXGI／CUDA 結果驗證分配邏輯：Intel 單內顯、AMD 單內顯、NVIDIA 單獨顯、AMD 單獨顯、Intel＋NVIDIA、AMD＋NVIDIA（含手動選擇、已移除的 GPU、非 CUDA 裝置指定給 AI）、AMD＋AMD、兩張 NVIDIA（AI 與渲染分開、兩張相同型號金鑰不同）、Intel Arc、沒有硬體加速（只有 WARP）、偵測逾時、被停用的 GPU、實測失敗的編碼器不出現在選項。實機只驗證過 AMD＋NVIDIA 這一台。

## 5. 介面

- 設定 › 硬體與效能：目前分配與原因、手動選擇（介面 GPU、渲染 GPU、AI 裝置、硬體編碼器、GPU 記憶體上限）、偵測到的 GPU 與 CUDA、被停用的裝置、重新偵測、恢復預設。
- 診斷 › GPU 實際使用：每個角色實際使用的 GPU（與分配是否一致）、引擎使用率、專用記憶體、PID；每張 GPU 的總負載；本次啟動套用的介面參數。
