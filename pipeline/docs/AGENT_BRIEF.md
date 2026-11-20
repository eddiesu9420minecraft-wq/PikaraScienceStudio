# 各幕製作簡報（給負責單一幕的代理／協作者）

專案根目錄：`<PROJECT_DIR>`（以下簡稱 ROOT；請一律用絕對路徑）。

影片：Pikara Science EP01《AI 是怎麼在你的電腦上運行的？深入理解 llama.cpp》，1920×1080、60fps、繁體中文、Edge-TTS 台灣男聲旁白。觀眾是沒有程式背景的一般人。

## 一定要先讀

1. `docs/STYLE.md`：美術與動畫規範（色彩、字型、亮度、安全區、禁止事項、3D 寫法、檢查流程）。**必須遵守。**
2. `src/acts/types.ts`（ActProps）、`src/acts/actData.ts`、`src/entries/actXX.tsx`（你那一幕的獨立入口）。
3. 你那一幕的旁白與錨點：`src/data/narration.json` → `sequences.ep01.scenes[]`（找你的 `actXX`），每句有 `subtitle`（畫面字幕）與 `anchors`（名稱 → 觸發詞）。實際時間在 `src/data/timeline.generated.json` → `ep01.scenes[]`：`durationFrames`、`anchors.<name>.local`（本幕本地影格）。
4. 範例寫法：`src/scenes/test/GpuWorld.tsx`（Three.js 場景、材質、光照、instancedMesh、逐幀更新）、`src/scenes/test/GpuLabels.tsx`（3D 投影標註、細引線）、`src/scenes/test/DeskScene.tsx`（SVG + 2D 攝影機）、`src/components/PikaraBrand.tsx`（文字揭示動畫）。

## 時間軸目前是「估算版」

TTS 還在產生中，`timeline.generated.json` 暫時用字數估算長度；音檔完成後會重建，每幕長度與錨點位置會改變（通常 ±10%）。所以：

- **絕對不要寫死影格數或秒數。** 所有事件都以 `anchors.xxx` 為基準（可以加減少量偏移，例如 `anchors.gpu - 12`），段落長度用 `durationInFrames` 或兩個錨點的差來算。
- 錨點不存在時 `anchors.xxx` 是 undefined，請用 `src/acts/actData.ts` 的 `anchor(anchors, 'name')`（會丟錯誤）或自己做保護。
- 鏡頭若要「在兩個錨點之間移動」，用 `tween(frame, anchors.a, anchors.b, ...)` 之類寫法，讓它自動伸縮。

## 你可以改／不可以改

- **只能修改**：`src/acts/ActXX.tsx`（你的那一幕），以及新增 `src/acts/actXX/` 底下的檔案。
- **不可修改**：其他幕、`src/theme/*`、`src/lib/*`、`src/components/*`、`src/episode/*`、`src/Root.tsx`、`src/acts/registry.ts`、`src/acts/types.ts`、`src/acts/actData.ts`、`src/data/*`、`scripts/*`、`package.json`、`src/scenes/test/*`、`src/characters/*`（其他代理正在修改這些）。需要類似功能就複製一份到自己的資料夾。
- 不要畫字幕（外層會畫）。不要播放音訊（外層會混音）。
- 不要安裝新的 npm 套件。可用：react、remotion、three、@react-three/fiber、@remotion/three。

## 環境注意事項（Windows）

- Git Bash 先執行：`export PATH="/c/Program Files/nodejs:$PATH"`（否則找不到 node）。
- **Bash 的 heredoc 遇到中文引號等字元常會失敗**——寫檔一律用 Write／Edit 工具。
- 型別檢查：`node node_modules/typescript/bin/tsc --noEmit`，只需處理你自己檔案的錯誤（其他代理同時在改別的檔案）。
- 關鍵幀：`node scripts/stills.mjs <幀1,幀2,...> EP01-ActXX src/entries/actXX.tsx` → `out/stills/EP01-ActXX-<frame>.png`，用 Read 工具開圖檢查。每次 8–12 幀以內；GPU 與其他代理共用，不要渲染整段影片。
- 開啟 Remotion Studio 不需要。

## 品質要求（使用者明確要求）

- 參考 3Blue1Brown、Kurzgesagt、Branch Education、Apple Keynote 的水準，但建立 Pikara 自己的風格（見 STYLE.md）。
- 電影感鏡頭、有意義的連續轉場；充分運用 Three.js、SVG、Canvas、HTML 動畫。**不要做成會動的 PowerPoint**：避免靜態畫面、單純文字淡入、條列式卡片。
- 科學內容正確；抽象示意圖要標「示意圖」。不得虛構效能數據、硬體規格或測試結果。
- 不得出現文字裁切、穿模、閃爍、殘影；畫面不可過暗。
- 本幕開頭前 30 幀與結尾後 30 幀會被「資料點」圓形轉場遮罩（從畫面中央展開／收合），所以開頭與結尾的畫面中央放有意義的主體。
- 每個錨點附近至少檢查一張關鍵幀；發現問題直接修正，不要只靠程式能跑就當作完成。

## 回報（完成時，300 字內）

做了什麼（鏡頭與畫面設計摘要）、檢查過哪些關鍵幀、已知剩餘問題、任何需要整合者處理的事。
