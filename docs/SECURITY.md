# 安全

## 現況（v0.3.1 + feat/cross-platform）

- Studio 目前**沒有**自我更新功能，也沒有對外下載模型或執行環境的程式碼（使用者自行安裝 ffmpeg、Python、Node、CosyVoice）。由 Create Your World（CYW）安裝時，更新由 CYW 處理。
- 前端 CSP：`script-src 'self'`，只允許 `ipc:` 與 asset protocol。
- 佇列腳本參數經 `safe_token` 檢查（不能帶 `-` 開頭、`..`、路徑跳脫）。
- 公開 repo 不含任何私鑰、token 或使用者路徑；CI（cross-platform.yml）不使用任何 secret。

## 計畫（P9，未實作）

採用 CYW 的 `crates/pikara-secure`（以 vendored 複本＋同步腳本的方式，與 pikara-splash 相同，不直接修改 CYW）：

| 機制 | 來源 |
|---|---|
| DNS-over-HTTPS（Cloudflare／Google，內建 bootstrap IP、失敗切換） | `pikara_secure::doh` |
| 只允許 HTTPS、主機與轉址白名單、嚴格 TLS（rustls） | `pikara_secure::net` |
| update.json 簽章（minisign，Pikara release key ID 13216449EEB947A5）、防降級、防重放 | `pikara_secure::manifest` |
| 下載檔串流 SHA-256 + minisign | `pikara_secure::artifact` |

Studio 端規則：
1. 製作工作執行中（佇列有 running／暫停中的工作）絕不安裝更新、絕不關閉 Studio；只提示。
2. 偵測到由 CYW 安裝（CYW 的安裝紀錄／資料夾）時，Studio 不自行更新，交給 CYW，避免兩邊同時替換檔案。
3. 獨立安裝的 Studio 可自我更新，使用相同信任模型；更新前保留舊版以便回復。
4. Apple 公證與 Pikara 更新簽章是兩條獨立的信任鏈。

## 需要使用者決定

- 把 Pikara release 私鑰加為 Studio repo 的 Actions secret（目前只在 CYW repo 與本機受密碼保護的資料夾）。私鑰永遠不進 repo、不印在 log。
- 在 CYW `products.json` 加上 Studio 的 `minisignPublicKey` 會讓 CYW 只接受簽章過的 Studio 版本——必須等 Studio 的簽章發佈流程完成後才加，否則 CYW 會拒絕安裝現有未簽章版本。
