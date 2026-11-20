# Pikara Science 美術與動畫規範（所有幕共用）

這份文件是 EP01 各幕的共同規範。每一幕可以由不同人／代理製作，但成品必須看起來像同一部片。

## 1. 視覺語言

- **基調**：深色、乾淨、有空氣感的「夜間實驗室」。背景使用 `palette.ink`（#090D18）、`night`、`wall`，不要純黑，也不要大面積漸層。
- **兩個資訊色**：`amber`（#FFB547）代表權重、模型、正值、重點；`ice`（#5CC8FF）代表資料流、輸入、負值。`mint` 只少量點綴。其他顏色一律從 `src/theme/palette.ts` 取，不要自己發明新色。
- **亮度**：主體要看得清楚。3D 場景的 toneMappingExposure 約 1.1–1.25，主體至少要有主光、輪廓光、環境反射三種光。不要整片暗到看不清，也不要過曝。
- **不要做的事**：圓角卡片堆疊、PowerPoint 式條列文字、霓虹過度發光（bloom）、無意義的漂浮粒子、Emoji、火柴人、廉價企業插畫、Minecraft 式的等大方塊堆疊。
- **抽象示意**：純粹解釋原理的畫面（矩陣、向量、注意力等）必須在畫面角落標示「示意圖」，避免被當成真實微觀結構。
- **文字**：字型一律 `fontStack`（Noto Sans TC）。標題 48–72px，標註 22–30px，最小 18px。畫面文字要少，旁白已經在講的內容不必再寫一次；標籤用「細引線＋小字」（參考 `src/scenes/test/GpuLabels.tsx` 的 Callout），不要加卡片底框。
- **安全區**：重要內容放在 x 120–1800、y 80–860。**y > 880 的區域保留給字幕**（字幕 55px，位於底部）。

## 2. 動畫與鏡頭

- 所有動畫只依賴 `frame`（逐幀確定性）。禁止 `Math.random()`、`Date.now()`、`requestAnimationFrame`、CSS transition/animation。需要亂數用 `rng(seed)`（`src/lib/anim.ts`）。
- 用 `src/lib/anim.ts` 的 `tween`、`progress`、`keyframes`、`ease.*`（`ease.camera` 適合有重量感的鏡頭）。2D 鏡頭用 `src/lib/camera2d.tsx`，3D 鏡頭用 `src/lib/camera3d.ts` 的 `makeRig`（Catmull-Rom＋平滑，不會每個關鍵點停頓）。
- **旁白驅動**：畫面事件以 `anchors.xxx`（本幕本地影格，旁白念出該詞的那一幀）為準，不要寫死秒數。一般做法：`progress(frame, anchors.gpu - 10, anchors.gpu + 30)`。新事件的前置動作可以提早 5–15 幀開始，讓畫面「剛好」在詞念出時到位。
- 鏡頭要有連續性：一幕內盡量是少數幾個連續的長鏡頭（推、拉、搖、跟），用物件本身的變形銜接下一個概念（例如一個數字放大變成一張矩陣），不要「淡出 → 淡入下一張圖」。
- 動作要有預備與跟隨（anticipation / overshoot），用 `ease.out` 或 `ease.camera`；避免全部線性。
- 禁止：閃爍、殘影、模型穿插、文字被裁切、畫面跳動。

## 3. 3D（Three.js / @remotion/three）

- 使用 `<ThreeCanvas>`（`@remotion/three`），在 `useLayoutEffect` 中依 frame 更新物件；不要用 `useFrame`。
- 參考 `src/scenes/test/GpuWorld.tsx`：`RoomEnvironment` + PMREM 做環境反射、ACES tone mapping、主光（暖白、帶陰影）＋冷色輪廓光＋補光。
- 材質要有層次：PCB（略帶綠的深色、粗糙）、金屬（高 metalness、低 roughness、有環境反射）、矽晶片（深藍灰、細緻反光）、散熱鰭片（鋁、細線條）。
- 模型比例合理：GPU 晶片周圍有 VRAM 顆粒、主機板有插槽與走線、記憶體條有顆粒與金手指、SSD 有控制器與 NAND 顆粒。
- 有大量重複物件時用 `instancedMesh`。

## 4. 共用元件（可直接 import）

- `src/theme/palette.ts`、`src/theme/fonts.ts`（`fontStack`、`type.title/label/mono/display`）
- `src/lib/anim.ts`、`src/lib/camera2d.tsx`、`src/lib/camera3d.ts`
- `src/characters/Lin.tsx`：原創人物「林予晴」（只有在需要人物時使用）
- `src/components/Vignette.tsx`（柔和暗角）
- `src/scenes/test/GpuWorld.tsx`、`GpuLabels.tsx`：第一幕的 3D 顯示卡與標註寫法範例

## 5. 每一幕的介面

```ts
// src/acts/ActXX.tsx
export const ActXX: React.FC<ActProps> = ({frame, durationInFrames, fps, anchors, lines}) => ...
```

- `frame` 是本幕本地影格（0 起算，可能是小數）。
- 字幕與旁白音訊由外層負責，**幕內不要再畫字幕**。
- 幕與幕之間由 Episode 套用「資料點」轉場：上一幕最後 30 幀收合成畫面中央的琥珀色資料點，下一幕前 30 幀從同一點展開。所以本幕**開頭與結尾的畫面中心**最好放有意義的主體，讓收合／展開看起來有意圖。
- 可以在 `src/acts/actXX/` 底下新增子元件檔案；不要修改別幕的檔案或共用檔案（`palette`、`anim`、`Root`、`registry`、`Subtitles` 等）。如果需要共用功能，就複製到自己的資料夾。

## 6. 檢查流程

```powershell
# 型別檢查（只看自己檔案的錯誤）
node node_modules/typescript/bin/tsc --noEmit
# 渲染關鍵幀 PNG（GPU）→ out/stills/EP01-ActXX-xxxxx.png，再用圖片檢視
node scripts/stills.mjs 0,300,900 EP01-ActXX src/entries/actXX.tsx
```

每一個錨點附近都要至少看一張截圖，確認：主體清楚、亮度足夠、沒有文字裁切或重疊、沒有穿模、與旁白內容一致、示意圖有標示。
