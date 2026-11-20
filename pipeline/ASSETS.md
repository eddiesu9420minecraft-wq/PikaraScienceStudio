# 素材清單（ASSETS）

所有視覺與聲音素材都由本專案程式產生，或為授權明確的字型／工具；沒有使用外部圖庫、音樂庫或 AI 生成圖像。

## 視覺

| 素材 | 位置 | 來源／授權 |
|---|---|---|
| 人物「林予晴」（側面坐姿） | `src/characters/Lin.tsx` | 原創 SVG 向量，程式繪製。固定配色在 `src/theme/palette.ts`（skin / hair / hoodie / pants），跨場景必須沿用此元件以維持外觀一致 |
| 房間、桌面、螢幕、主機 | `src/scenes/test/DeskScene.tsx` | 原創 SVG／HTML |
| 3D 顯示卡、晶片、VRAM、散熱器 | `src/scenes/test/GpuWorld.tsx` | 原創 Three.js 程序化模型（非任何廠牌造型） |
| 權重矩陣視覺化 | 同上 `MatrixGrid` | 原創；數值以固定種子產生 |
| Pikara Science 標誌 | `src/components/PikaraBrand.tsx` | 原創：四道稜形組成的閃光＋冰藍方點 |
| 環境反射 | three.js `RoomEnvironment` | three.js 內建（MIT），程式產生，無外部 HDR 檔 |

## 字型

| 字型 | 位置 | 授權 |
|---|---|---|
| Noto Sans TC（Variable） | `public/fonts/NotoSansTC-VF.ttf` | SIL Open Font License 1.1。隨專案打包，渲染不依賴網路與系統字型 |

## 聲音

| 素材 | 位置 | 來源／授權 |
|---|---|---|
| 旁白 | `public/assets/audio/voiceover/<seq>/<id>.mp3`（+ `.json` 時間邊界） | Microsoft Edge 線上語音（edge-tts，`zh-TW-YunJheNeural`）合成。**商用前請自行確認微軟語音服務條款**；可隨時改用真人錄音（見 README） |
| 背景音樂 | `public/assets/audio/mix/_<seq>/bgm_raw.wav` | 原創：`scripts/mix_audio.py` 以 ffmpeg `aevalsrc` 合成（A 小調 add9／F 大七和弦交替），無第三方授權問題 |
| 音效（按鍵、送出、穿越、乘加、品牌鐘聲） | `public/assets/audio/generated/sfx_*.wav` | 原創：同上以 ffmpeg 合成 |
| 成品混音 | `public/assets/audio/mix/<seq>.wav` | 由以上素材混成 |

## 參考實作（概念，未複製程式碼）

- 說話區段 → ducking：heygen-com/hyperframes `packages/cli/src/media-use/lib/duck.mjs`（Apache-2.0）
- 混音鏈與限幅器延遲補償：givemotion/givemotion `src/ffmpeg.js`（MIT）
