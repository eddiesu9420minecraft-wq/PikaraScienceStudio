# Pikara Science EP01 — AI 是怎麼在你的電腦上運行的？

以 Remotion（React + TypeScript + SVG + Three.js）逐幀確定性製作的科普影片。目前完成**第一階段：有聲美術測試片**（`preview.mp4`，1920×1080／60fps／H.264 NVENC，23.2 秒）。

## 快速開始

```powershell
npm install
npm run gpu:check        # 實測 GPU：WebGL 後端、硬體編碼器（NVENC／AMF／QSV／VideoToolbox…）、驅動
npm run dev              # Remotion Studio（即時預覽、逐幀檢查）
npm run preview          # 720p 快速預覽 → out/ArtTest-preview-720p.mp4
npm run render:gpu       # 1080p60 正式渲染（ANGLE 硬體 WebGL＋實測可用的硬體編碼器，失敗自動改用 libx264）
```

> Windows 注意：專案路徑太長時（超過 260 字元），Remotion 內建的 headless Chrome 無法啟動。`scripts/lib.mjs` 會自動把它複製到 `%LOCALAPPDATA%\pikara-science\chrome-headless-shell` 再使用。

## 指令一覽

| 指令 | 作用 |
|---|---|
| `npm run gpu:check` | 列出所有顯示卡（不分品牌）、Chromium WebGL 實際使用的 GPU、每個硬體編碼器（NVENC／AMF／QSV／VideoToolbox／VA-API／Media Foundation）以正式參數實際試編碼 1 秒的結果；NVIDIA 另外顯示 VRAM 與溫度。輸出 `out/gpu-check.json`（WebGL 結果快取 24 小時，`--force` 重測）。單獨檢查編碼器：`node scripts/hwenc.mjs --all` |
| `npm run preview` | 720p 預覽（GPU；不可用時自動改 CPU 並說明原因） |
| `npm run render:gpu` | 1080p60 正式片。GPU 檢查不通過時**不會**自動降級，會停下並說明 |
| `npm run render:cpu` | 相容模式：SwiftShader 軟體 WebGL + libx264，畫質參數同等 |
| `npm run render:shot -- Shot2-GPU` | 單獨渲染一個鏡頭（Shot1-Desk／Shot2-GPU／Shot3-Matrix／Shot4-Brand） |
| `npm run benchmark` | 同一段幀、同並行數比較 GPU 與 CPU 的時間與資源 → `out/benchmark/BENCHMARK.md` |
| `npm run voiceover` | 產生全部旁白（Edge-TTS 台灣男聲） |
| `npm run voiceover:arttest` | 只產生測試片旁白 |
| `npm run voiceover:test` | 產生一句測試語音，確認語音服務可用 |
| `npm run voiceover:check` | 用 ffprobe 驗證所有旁白（存在、可讀、文字未變更、有時間邊界） |
| `npm run voiceover:sync` | 由實際音檔重建時間軸、字幕、SRT，並重新混音 |
| `npm run stills` | 渲染關鍵幀 PNG 到 `out/stills/` 供美術檢查 |
| `npm run typecheck` | TypeScript 檢查 |

`render.mjs` 其他參數：`--codec hevc`、`--encoder auto|h264_nvenc|h264_amf|h264_qsv|h264_videotoolbox|h264_vaapi|h264_mf|libx264`（預設 auto：依 `scripts/hw_encoders.json` 實測選用；編碼失敗會改用下一個，已渲染的幀不重做）、`--concurrency N`、`--frames a-b`、`--keep-frames`、`--allow-cpu-fallback`。

## 多集（EP01、EP02、EP03…）

- 每一集是 `narration.json` 的 `sequences.<epId>`（`ep` 加 2–3 位數字）。時間軸裡有的集數都會自動註冊 composition：`<EP>`（60fps）、`<EP>-30fps`、`<EP>-YT15`（例：`EP02-30fps`）。
- 有手工動畫的集數列在 `src/episode/registry.ts` 的 `CUSTOM_ACTS`（目前只有 EP01 的 7 幕）；其他集數自動使用通用旁白樣板 `src/episode/GenericAct.tsx`：章節標題、由錨點驅動的關鍵詞卡片（念到該詞時彈出）、句子進度點，底部保留字幕區。
- 輸出檔名一律由集數推得：`<EP>_Final.mp4`、`<EP>.srt`、`<EP>_YouTube_zh-TW.mp4`、`<EP>_Bilibili_zh-CN.mp4`。
- 指令：`bash scripts/finalize.sh ep02`（時間軸→字幕→混音→渲染→QA）、`node scripts/render.mjs gpu --comp EP02-30fps --out EP02_Final.mp4`、`py -3.11 scripts/make_cn.py --seq ep02`、`py -3.11 scripts/mix_audio.py --seq ep02`、`py -3.11 scripts/qa_video.py EP02_Final.mp4`。
- 繁體（`src/`）與簡體（`src_cn/`）的旁白與時間軸各自管理：`make_cn.py` 只為 src_cn 還沒有的集數轉換初稿，已存在的簡體集數與簡體時間軸不會被覆寫（`--reconvert` 才會重新轉換指定集數）。它先在暫存資料夾產生，成功後才替換 src_cn。
- 混音：EP01 用手工音效表與逐幕配樂；其他集數用通用規則（幕間轉場音、錨點提示音、片尾鐘聲；配樂依 `scenes[].mood` 或幕的位置）。
- 渲染續傳：`out/frames/<tag>/fingerprint.txt` 記錄原始碼＋該集時間軸的雜湊；改稿或改動畫後重新渲染會自動清除舊幀，不會新舊畫面混在一起。

## 旁白 → 時間軸 → 動畫（旁白驅動）

```
src/data/narration.json        ← 改稿只改這裡（字幕文字、朗讀文字、停頓、畫面錨點）
   │ npm run voiceover          scripts/generate_voiceover.py
   ▼
public/assets/audio/voiceover/<seq>/<id>.mp3 + .json（ffprobe 長度、WordBoundary 時間邊界）
   │ npm run voiceover:sync     scripts/build_timeline.py + scripts/mix_audio.py
   ▼
src/data/timeline.generated.json（每句起訖、字幕分段、錨點幀）、out/subtitles/<seq>.srt
public/assets/audio/mix/<seq>.wav（混音成品）
   │ Remotion
   ▼
動畫以「樣板影格」設計（src/scenes/test/shots.ts 的 TEMPLATE_ANCHORS），
執行時由 src/lib/timewarp.ts 把樣板錨點對齊到旁白錨點：
  念到「按下」→ 問題送出；念到「GPU」→ 顯示卡轉向鏡頭；「顯示記憶體」→ X 光透視與 VRAM 標註；
  「流進」→ 資料流；「晶片」→ 潛入晶片；「相乘」→ 乘加波前；「這裡是」→ 品牌
```

- **錨點**：在 `narration.json` 的句子加上 `"anchors": {"gpu": "GPU"}`；建置時以 Edge-TTS 的 WordBoundary 找到這個詞被念出的那一幀。
- **字幕與朗讀分開**：`subtitle` 顯示在畫面上，`speak`（可省略）是實際朗讀文字，例如字幕 `llama.cpp`、朗讀 `llama C P P`。
- **字幕分段**：依標點切分，每段不超過 18 個字，時間取自 WordBoundary。
- **影片長度由旁白決定**：測試片原訂 15 秒，旁白實測 23.2 秒，因此影片是 23.2 秒，而不是把旁白硬塞進 15 秒。

### Edge-TTS 產生器的可靠性設計

- 固定語音 `zh-TW-YunJheNeural`；若某句指定其他配音員會直接報錯。全部失敗時**不會**改用別的語音。
- 每句最多重試 5 次，指數退避（1.5s、3s、6s、12s，加隨機抖動），同時最多 2 個請求（`--concurrency` 上限 4）。
- 先寫入 `.part` 暫存檔，經 ffprobe 驗證有效且長度大於 0.3 秒才改名；失敗會刪除殘檔。
- 快取鍵 = SHA-256(朗讀文字 + 語音設定 + 產生器版本)，只重新產生有變動的句子。
- 實測：第一次產生時有 2 句遇到 `NoAudioReceived`，分別在第 2、4 次重試成功。

### 換成真人配音

把錄音存成同名 `public/assets/audio/voiceover/<seq>/<id>.mp3`（或 WAV 轉 MP3），然後二選一：

1. 刪除對應 `.json` 的 `boundaries`：字幕與錨點改用字數比例估算（會印出警告）。
2. 若有強制對齊工具產生的字詞時間，填進 `.json` 的 `boundaries`（格式同 Edge-TTS：`text`／`start`／`end` 秒）即可精準同步。

接著執行 `npm run voiceover:sync`，再重新渲染。

### 音訊後製（`scripts/mix_audio.py`）

- 旁白依時間軸排入，經兩段式 `loudnorm` 調到 -16 LUFS。
- 背景音樂（ffmpeg 合成的原創氛圍音）基準 -27 LUFS；說話區段（WordBoundary 合併，間隔小於 0.6 秒視為同一段）再降 11 dB，attack 0.15 秒、release 0.45 秒。
- 音效（按鍵、送出、穿越、乘加、品牌鐘聲）依動畫事件時間排入。
- 混音後整體 `loudnorm`（-16 LUFS／-1.5 dBTP），再經前視限幅器，並補償限幅器延遲。
- 測試片實測：成品 -16.0 LUFS、峰值 -1.5 dBFS；旁白比 ducking 後的背景音樂高 16.6 dB。

## GPU 加速（RTX 4050 Laptop 6GB 實測）

- **WebGL**：`--gl=angle` → `ANGLE (NVIDIA GeForce RTX 4050 Laptop GPU, Direct3D11)`。`swangle` 是 SwiftShader 軟體渲染，`angle-egl` 在這台電腦會落到 Microsoft Basic Render（也是軟體），所以兩者只當 CPU 模式使用。
- **編碼**：Remotion 內建的 ffmpeg 沒有 NVENC，所以先以 Remotion 輸出 JPEG（q98）幀序列，再用系統 ffmpeg 的 `h264_nvenc` 編碼（preset p7、tune hq、VBR CQ17、spatial／temporal AQ、BT.709 TV range）。成品串流標籤為 `h264_nvenc`；編碼期間 nvidia-smi 顯示 NVENC 使用率峰值 99%。
- **並行數**：依可用 VRAM 計算 `floor((free − 1500 MiB) / 400 MiB)`，上限 4。整片渲染時 VRAM 峰值約 4.1 GB（含系統與其他程式約 2.3 GB）。
- **Benchmark**（180 幀 1080p、3D 最重段落、並行 3）：GPU 總時間 22.1 秒，CPU 168.2 秒，快 7.6 倍；渲染速度 13.7 對 1.1 fps。詳見 `out/benchmark/BENCHMARK.md`。
- **筆電混合顯示**：若 `gpu:check` 顯示 Radeon 740M，請到「Windows 設定 > 系統 > 顯示器 > 圖形」把 `%LOCALAPPDATA%\pikara-science\chrome-headless-shell\chrome-headless-shell.exe` 設為「高效能」。這台電腦目前預設已使用 NVIDIA。
- Edge-TTS 是微軟雲端服務，與 CUDA 無關。

## 專案結構

```
src/
  theme/       palette.ts（統一色彩）、fonts.ts（Noto Sans TC 載入）
  lib/         anim.ts（easing／關鍵影格／種子亂數）、camera2d.tsx、camera3d.ts（Catmull-Rom 平滑鏡頭）、timewarp.ts
  characters/  Lin.tsx（原創人物）
  components/  PikaraBrand、Subtitles、Vignette
  scenes/test/ 第一階段：DeskScene（2D）→ GpuWorld（3D）→ GpuLabels（投影標註）→ ArtTest（總合成）
  data/        narration.json、timeline.generated.json、timeline.ts
  diagnostics/ GpuProbe（讀取 WebGL 實際使用的顯示卡）
scripts/       generate_voiceover.py、build_timeline.py、mix_audio.py、render.mjs、gpu-check.mjs、benchmark.mjs、stills.mjs、lib.mjs
```

## 鏡頭語言（第一階段）

單一連續鏡頭：桌前人物打字 → 推鏡到主機側透玻璃（2D 推鏡速度與 3D 相機銜接，再交叉溶接）→ 3D 顯示卡由裝機姿態轉向鏡頭 → 外殼與散熱器抬起、變成 X 光透視 → VRAM 到 GPU 的資料流 → 潛入晶片 → 晶片表面化為權重矩陣，執行 y = W·x 乘加波前 → 拉遠轉暗 → Pikara Science 品牌。3D 標註以同一個攝影機函式投影，逐幀貼合物件。

## 已知限制／下一步

- 只完成第一階段測試片；第二到第七幕尚未製作（配音稿已在 `narration.json` 的 `ep01`）。
- 人物目前只有側面坐姿一種姿勢，其他角度與動作待後續製作。
- 美術自動檢查目前靠 `npm run stills` 抽關鍵幀人工審閱；givemotion `check.js`（MIT）的字型缺字與文字溢出檢查可移植為下一步。
- Edge-TTS 語音用於商業發布前，請確認微軟的服務條款。
