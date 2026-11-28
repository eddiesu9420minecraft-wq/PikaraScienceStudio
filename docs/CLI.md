# Pikara Science Studio 指令列

同一套指令在三個平台上都能用，背後和視窗版是同一個引擎（`crates/studio-core`）：資料庫、任務佇列、自動製作、設定、驗證都共用，所以從終端機做的影片和在視窗裡做的影片走的是同一條程式碼。

| 平台 | 執行檔 | 說明 |
|---|---|---|
| Windows x64 | `PikaraScienceStudio.exe` | 不加參數開視窗；加任何指令或 `nogui` 只用指令列 |
| macOS（Apple Silicon／Intel） | `Pikara Science Studio.app/Contents/MacOS/PikaraScienceStudio` | 同上 |
| Linux x86_64／arm64 | `PikaraScienceStudio`（.tar.gz 內） | 只有指令列；不需要 WebView、X11、Wayland 或桌面環境，可在 SSH、無頭伺服器使用 |

所有平台另外附 `pikara-studio`（純指令列執行檔，不含視窗程式碼），行為與上面相同。

## 基本用法

```
PikaraScienceStudio [--data <資料夾>] [--json] [--quiet] <指令> [選項]
```

- `--data <資料夾>`：使用另一個資料夾的資料庫與佇列（測試、多個工作區）。預設是使用者的 Studio 資料夾（`config path` 顯示位置）。
- `--json`：輸出機器可讀的 JSON（一個指令一個物件；`run`、`status --follow`、`logs --follow`、`create --wait` 每行一個事件，NDJSON）。
- `--quiet`：只輸出結果與錯誤。

## 指令

| 指令 | 用途 |
|---|---|
| `create --project <資料夾> --topic <主題> [...]` | 建立影片；選項與「新影片」頁相同（`create --help`）。`--draft` 建立草稿；`--wait` 在這個程序執行到完成 |
| `start <ID>` | 開始草稿 |
| `run [--stay] [--timeout 秒]` | 在前景執行佇列與自動製作（伺服器／SSH）。視窗開著時回傳 5，請改用 `status --follow` |
| `status [<ID>] [--follow]` | 製作狀態頁的 11 個步驟、整體進度、目前工作、錯誤、成品 |
| `list [--limit n]` | 全部製作 |
| `logs <ID> [--follow] [--tail n]` | 製作與目前工作的日誌 |
| `pause` / `resume` / `cancel` / `retry` `<ID>` | 控制製作；`retry` 對失敗的製作重新嘗試，對執行中的製作重新開始目前步驟 |
| `revoice <ID> [--lines "L01 L02"]` | 單獨重新配音（舊版本保留） |
| `render <ID> [--locale zh-TW\|zh-CN]` | 單獨重新渲染 |
| `agent task <ID>` / `agent done <ID> [--failed] [--note 文字]` | 外部 AI Agent 介面（`--agent external`） |
| `doctor [--project <資料夾>] [--gpu-tests]` | 環境檢查 |
| `hardware` | 硬體、GPU、編碼器、裝置分配（唯讀，不開資料庫） |
| `config get [項目]` / `config set <項目> <值>` / `config set --json '<patch>'` / `config path` | 設定 |
| `project list` / `project add <資料夾>` / `project new --dest <資料夾> --title <名稱>` | 專案 |
| `version`（`--version`） | 版本、commit、平台 |

ID 可以只打前幾個字元（例：`status 1a2b3c4d`）。

舊的自動化指令（`auto-start`、`auto-run`、`auto-status`、`job-log`、`voice-promote` …）照舊可用：`PikaraScienceStudio --cli <指令>`，也可以直接 `PikaraScienceStudio <指令>`。

## 結束碼

| 碼 | 意義 |
|---|---|
| 0 | 成功 |
| 1 | 指令執行了但失敗（狀態不允許、檢查沒過、無法排入工作） |
| 2 | 用法錯誤（未知指令、缺少或無效的參數） |
| 3 | 找不到製作、工作、專案或檔案 |
| 4 | `doctor`：至少一項環境檢查是錯誤 |
| 5 | 這個資料夾的佇列已由另一個 Studio（視窗或 `run`）執行 |
| 6 | `--timeout` 到了 |
| 7 | 等待的製作或工作以失敗／取消結束 |
| 10 | 無法開啟 Studio 資料庫 |
| 130 | 被 Ctrl-C／SIGTERM 中斷（進度保留，再執行 `run` 從中斷處繼續） |

## 中斷與繼續

- `run` 被中斷（Ctrl-C、SSH 斷線、關機）時，正在執行的程序會被停止，工作留在可恢復的狀態。下次 `run`（或開啟視窗）時會自動恢復：配音逐句快取、渲染逐段快取，已完成的部分不會重做。
- 需要在 SSH 斷線後繼續：`nohup PikaraScienceStudio run --stay > studio.log 2>&1 &`，或在 `tmux`／`screen` 裡執行，或做成 systemd 服務（`docs/LINUX.md`）。

## AI Agent 自動化

```
id=$(PikaraScienceStudio --json create --project ~/videos/pikara --topic "黑洞是怎麼形成的" --agent external | jq -r .id)
PikaraScienceStudio run --stay &          # 執行者
while :; do
  s=$(PikaraScienceStudio --json status "$id" | jq -r .production.status)
  case $s in
    waiting_agent) PikaraScienceStudio --json agent task "$id" > task.json   # 讀 prompt，在 workdir 完成工作
                   PikaraScienceStudio agent done "$id" ;;
    succeeded) break ;;
    failed|canceled) exit 7 ;;
  esac
  sleep 10
done
```

每個輸出都有 `ok` 欄位；失敗時另有 `error` 與 `exitCode`。
