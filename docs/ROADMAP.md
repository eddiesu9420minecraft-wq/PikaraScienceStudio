# 跨平台路線圖

| 階段 | 內容 | 狀態 |
|---|---|---|
| P0 | 完整稽核 → `CROSS_PLATFORM_AUDIT.md` | ✅ 完成 |
| P1 | 平台層（`src/platform`）、程序管理、統一介面（程序邊界契約，ARCHITECTURE.md） | ✅ 主體完成；Windows 測試通過，macOS／Linux 由 CI 驗證 |
| P2 | 語音：保留 Windows CosyVoice 3 CUDA；macOS 候選 A/B（`voice_ab.py` + 測試句已備妥） | ⏳ 等 Mac 真機 |
| P3 | ASR：mlx-whisper／whisper.cpp／faster-whisper CPU 比較 | ⏳ 等 Mac 真機 |
| P4 | 渲染／編碼：VideoToolbox 實測、WebGL/Metal 實測、90 幀實際渲染 | 🔄 CI 實測中；真機待做 |
| P5 | 硬體偵測（Windows 不變＋macOS sysctl/system_profiler）、功率模式預算 | ✅ 完成（常數待校正） |
| P6 | 與 CYW 共用 runtime（uv、Python、Node、FFmpeg、模型快取、續傳、SHA-256、回復） | ⬜ 未開始：需與 CYW 主 session 協調共用快取位置與鎖 |
| P7 | splash／前端不預載重資源 | ✅ 已驗證（前端無 three／remotion／webgl 匯入）；macOS 透明視窗見 KNOWN_ISSUES #4 |
| P8 | UI：暫停／繼續（已完成）；目前狀態頁、自訂功率模式欄位、重配音／重渲染入口整理 | 🔄 部分 |
| P9 | 安全更新（pikara-secure） | ⬜ 未開始 |
| P10 | 資料安全：online backup、遷移鎖、還原保護、競賽測試 | ✅ 完成 |
| P11 | CI：四平台測試＋macOS 未簽章套件 | ✅ 建立；簽章發佈需使用者同意加 secret；`.app.tar.gz` 需改名含架構 |
| P12 | 完整端到端（Windows RTX 4050、Mac mini M2） | ⏳ Windows 可做；Mac 等存取 |

## 下一步（依序）

1. 讀 CI 結果，修 macOS／Linux 的編譯或測試失敗（若有）。
2. 配音腳本讀 `PIKARA_AI_DEVICE=apple`（MPS 嘗試 → 失敗退 CPU fp32，並記錄原因）與 `PIKARA_TTS_BATCH_MAX`。
3. 取得 Mac mini M2 存取後：accel_probe、hwenc、gpu-check、voice_ab（A–D 候選）、ASR 比較、1080p30 整集。
4. P6 共用 runtime（與 CYW 協調）。
5. P9 更新。
