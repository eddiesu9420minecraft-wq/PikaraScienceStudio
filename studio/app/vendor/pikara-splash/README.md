# pikara-splash — Pikara 統一啟動畫面

所有 Pikara 桌面軟體（Create Your World、Pikara Science Studio…）共用的啟動畫面與轉場：一個 Tauri 2 外掛（Rust）加一個不依賴框架的前端（TypeScript / CSS / SVG）。

- 品牌：原創幾何 Logo（四個金色角楔形＋中央菱形）、金色品牌色、Source Han Sans / Noto Sans TC、深色與淺色（`prefers-color-scheme`，或 `theme` 參數強制）。
- 每個 App 顯示自己的名稱與版本（版本預設取自 `tauri.conf.json`）。
- 只顯示**真實**狀態：每個初始化步驟一段進度條，顏色就是該步驟的真實狀態（執行中／完成／提醒／失敗／略過）。沒有假進度、沒有刻意延遲。
- 初始化在背景執行，不會被畫面擋住；後端與主視窗都就緒的那一刻就開始轉場，主視窗在轉場**開始時**就顯示並可操作，不等動畫。
- 失敗時顯示錯誤內容與復原選項（重試、開啟資料夾、略過…、結束），永遠不會卡在啟動畫面；某一步太久（預設 8 秒）會顯示提示與可選動作。
- 只用 CSS / SVG，無 3D、無外部相依；`prefers-reduced-motion` 時不移動，只做短淡入淡出。
- Windows、macOS、Linux（透明視窗在 macOS 需要 `macOSPrivateApi`）。

## 共用方式（單一來源）

**唯一的原始碼在 CreateYourWorld 的 `crates/pikara-splash/`**。不要在其他 repo 修改它。

| 使用者 | 方式 |
|---|---|
| Create Your World（同 repo） | Rust：`path = "../crates/pikara-splash"`；前端：Vite 直接編譯 `web/src`（`@pikara/splash` alias → `web/src/react.tsx`）。 |
| 其他 repo（例如 Pikara Science Studio） | **vendored 副本**：`node <CYW>/crates/pikara-splash/sync.mjs --to <app 目錄>` 依 `<app>/pikara-splash.vendor.json` 把 crate 複製到 `rust` 目錄、把編譯好的 `web/dist/*`（純 ES module，免 bundler）複製到 `web` 目錄，並在 manifest 記錄版本、來源 commit 與每個檔案的 SHA-256。 |

為什麼用 vendored 副本而不是 git 相依：兩個 repo 各自獨立、可離線建置；Studio 沒有前端 bundler，需要的是編譯後的 JS；而 manifest 的雜湊讓「有人直接改了副本」可以被偵測：

```
node vendor/pikara-splash/sync.mjs --check .     # 在 Studio 的 studio/app 目錄執行，副本被改過會 exit 1
```

更新流程：在 CYW 修改 `crates/pikara-splash` → commit → 在 Studio 執行 `sync.mjs --to` → 建置測試 → commit（manifest 會記下對應的 CYW commit）。

## 使用方式

### 1. tauri.conf.json

```jsonc
"windows": [
  { "label": "splash", "url": "splash.html", "width": 560, "height": 340, "center": true,
    "resizable": false, "decorations": false, "transparent": true, "shadow": false,
    "alwaysOnTop": true, "visible": false },
  { "label": "main", "visible": false /* 其他設定照舊 */ }
]
```

capability 要涵蓋兩個視窗並加入 `"pikara-splash:default"` 與 `"core:window:allow-start-dragging"`。

### 2. Rust

```rust
use pikara_splash::{Action, Failure, SplashExt};

tauri::Builder::default()
    .plugin(pikara_splash::init(
        pikara_splash::Config::new()
            .step("db", "資料庫")
            .step("recover", "工作佇列")
            .slow_action_for("db", Action::new("open_data", "開啟資料夾"))
            .on_action(|app, id| { /* 非阻塞動作，例如開啟資料夾 */ }),
    ))
    .setup(|app| {
        let h = app.handle().clone();
        std::thread::spawn(move || {
            let s = h.splash();
            s.begin("db", "正在開啟資料庫…");
            let db = loop {
                match open_db() {
                    Ok(db) => break db,
                    // 使用者按「重試」就再試一次；「結束」由外掛直接結束程式
                    Err(e) => { s.fail_blocking(Failure::new("db", "無法開啟資料庫", e)
                        .action(Action::quit("結束"))
                        .action(Action::primary("retry", "重試"))); }
                }
            };
            s.done("db");
            // … 其他步驟：begin / done / done_with / warn / skip …
            s.backend_done();
        });
        Ok(())
    })
```

- `begin(id, 訊息)` 開始一步（上一步若仍在執行會自動標為完成）。
- `done` / `done_with(id, 結果)` / `warn(id, 說明)`（非致命，會列在提醒）/ `skip(id, 原因)`。
- `fail_blocking(Failure)`（同步執行緒）或 `fail(Failure).await`：顯示錯誤與按鈕，回傳使用者選的動作 id。`quit` 由外掛處理（結束程式）。
- `wait_action(&[ids]).await`：例如讓「略過網路檢查」按鈕中斷某一步。
- `backend_done()`：後端完成。之後主視窗 10 秒內沒有回報 `main_ready` 也會自動顯示。
- `pikara_splash::focus(app)`：單一實例回呼用，啟動中聚焦啟動畫面，之後聚焦主視窗。

### 3. 前端

Splash 視窗（`splash.html`，越小越好，不載入主程式）：

```js
import { mountSplash } from "./vendor/pikara-splash/pikara-splash.js"; // 或 CYW：web/src/pikara-splash
mountSplash(document.getElementById("root"), { productName: "Pikara Science Studio", tagline: "科普影片工作室", theme: "system" });
```

主視窗：

```js
import { createBridge, mountReveal } from "./vendor/pikara-splash/pikara-splash.js";
const splash = createBridge();            // 預設走 window.__TAURI__；bundler 專案可傳入 transport
mountReveal(document.body, { background: "<主視窗底色>" }); // 在第一次繪製前掛上
await splash.waitReady();                 // 後端初始化完成
/* 載入真實資料並繪製 */
splash.mainReady();
```

React（CYW）：`import { SplashScreen, RevealOverlay, PikaraLogo } from "@pikara/splash"`。

## 測試用掛鉤（只供測試）

- `PIKARA_SPLASH_TEST_DELAY=db:6000,env:2000`：讓指定步驟多花指定毫秒（模擬慢速初始化）。
- `PIKARA_SPLASH_TEST_FAIL=<step>`：App 若呼叫 `injected_failure(step)`，第一次會得到一個注入的錯誤（重試後消失），用來測試復原流程。
- 啟用任一掛鉤時，`status` 的 `testHooks` 欄位會標示，避免把測試結果誤當真實數據。
- `status` 的 `timings`（`startedUnixMs`、`shownMs`、`backendDoneMs`、`frontendReadyMs`、`completeMs`、`revealedMs`）用來量測啟動時間。

## 事件與指令

指令（`plugin:pikara-splash|…`）：`status`、`shown`、`reveal_main`、`close`、`main_ready`、`wait_ready`、`action {id}`。
事件：`pikara-splash://status`（快照）、`pikara-splash://complete`、`pikara-splash://reveal`。
