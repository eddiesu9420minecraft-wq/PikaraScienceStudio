//! Claude prompt generator: fixed templates filled with live project data.

use crate::{gitops, narration};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn tasks() -> Value {
    json!([
        {"id": "rewrite_act_pacing", "label": "重寫一幕的節奏", "description": "調整某一幕的句子長度、停頓與錨點，讓節奏更緊湊", "needs": ["seqKey", "sceneId", "notes"]},
        {"id": "fix_qa_issues", "label": "修正 QA 問題", "description": "依最新 out/qa/*.md 報告提出並套用修正", "needs": ["seqKey", "notes"]},
        {"id": "new_episode_script", "label": "由主題產生新一集腳本", "description": "依現有 narration.json 格式產生新 sequence", "needs": ["topic", "notes"]},
        {"id": "fix_failed_job", "label": "分析失敗的工作", "description": "附上工作 log 與 QA 報告，找出原因並修正", "needs": ["jobId", "notes"]},
        {"id": "improve_anchors", "label": "改善畫面錨點", "description": "檢查錨點詞是否落在正確的朗讀位置", "needs": ["seqKey", "sceneId"]},
        {"id": "translate_cn_review", "label": "審查 zh-CN 用語", "description": "對照 zh-TW 與 zh-CN 字幕，找出不自然的大陸用語", "needs": ["sceneId"]}
    ])
}

pub struct Extra {
    pub job_summary: Option<String>,
    pub job_log_tail: Option<String>,
}

fn scene_lines(seq: &Value, scene_id: &str) -> Option<(String, Vec<Value>)> {
    seq["scenes"].as_array()?.iter().find(|s| s["id"] == scene_id).map(|s| {
        (s["title"].as_str().unwrap_or("").to_string(), s["lines"].as_array().cloned().unwrap_or_default())
    })
}

fn fmt_line(l: &Value) -> String {
    let mut s = format!("- `{}` 字幕：{}", l["id"].as_str().unwrap_or("?"), l["subtitle"].as_str().unwrap_or(""));
    if let Some(sp) = l["speak"].as_str() {
        s.push_str(&format!("｜朗讀：{sp}"));
    }
    if let Some(a) = l["anchors"].as_object().filter(|a| !a.is_empty()) {
        s.push_str(&format!("｜錨點：{}", serde_json::to_string(a).unwrap_or_default()));
    }
    if let Some(p) = l["pauseAfter"].as_f64() {
        s.push_str(&format!("｜pauseAfter {p}"));
    }
    s
}

/// Newest out/qa/*.md (optionally the one matching a video name).
pub fn latest_qa(root: &Path) -> Option<(PathBuf, String)> {
    let dir = root.join("out").join("qa");
    let mut v: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .filter(|e| e.path().extension().map(|x| x == "md").unwrap_or(false))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    v.sort();
    let p = v.pop()?.1;
    let t = std::fs::read_to_string(&p).ok()?;
    Some((p, t))
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    s.chars().take(n).collect::<String>() + "\n…（截斷）"
}

pub fn build(root: &Path, task: &str, opt: &Value, extra: &Extra) -> Result<String, String> {
    let locale = opt["locale"].as_str().unwrap_or("zh-TW");
    let nf = narration::read(root, locale)?;
    let seq_key = opt["seqKey"].as_str().unwrap_or("ep01");
    let seqs = nf["sequences"].as_array().cloned().unwrap_or_default();
    let seq = seqs.iter().find(|s| s["key"] == seq_key).cloned().unwrap_or(json!({"scenes": []}));
    let scenes = seq["scenes"].as_array().cloned().unwrap_or_default();
    let n_lines: usize = scenes.iter().map(|s| s["lines"].as_array().map(|a| a.len()).unwrap_or(0)).sum();
    let git = gitops::status(root);
    let notes = opt["notes"].as_str().filter(|s| !s.trim().is_empty());

    let mut p = String::new();
    p.push_str("你是 Pikara Science 科普影片專案的協作者。專案是 Remotion（React + TypeScript）旁白驅動動畫，");
    p.push_str("請先閱讀 `.claude/skills/pikara-video/SKILL.md` 了解管線規則。\n\n");
    p.push_str("## 專案現況\n");
    p.push_str(&format!("- 專案路徑：{}\n", root.display()));
    p.push_str(&format!(
        "- Git：分支 {}，HEAD {}（{}），工作目錄未提交變更 {} 個\n",
        git.branch.clone().unwrap_or("?".into()),
        git.head.clone().map(|h| h[..7.min(h.len())].to_string()).unwrap_or("?".into()),
        git.head_subject.clone().unwrap_or_default(),
        git.dirty.len()
    ));
    p.push_str(&format!(
        "- 集數：`{seq_key}`「{}」，{} 幕、{n_lines} 句（{}，檔案 {}）\n",
        seq["title"].as_str().unwrap_or(""),
        scenes.len(),
        locale,
        narration::rel_path(locale)?
    ));
    p.push_str("- 幕列表：\n");
    for s in &scenes {
        let ls = s["lines"].as_array().cloned().unwrap_or_default();
        p.push_str(&format!(
            "  - `{}` {}（{} 句）首句：{}\n",
            s["id"].as_str().unwrap_or(""),
            s["title"].as_str().unwrap_or(""),
            ls.len(),
            ls.first().and_then(|l| l["subtitle"].as_str()).unwrap_or("")
        ));
    }
    p.push('\n');

    let rules = "\n## 規則\n- 只修改需要的檔案；narration.json 保持 2 空格縮排與原有鍵順序。\n- 錨點詞必須出現在該句的朗讀文字（speak，沒有時為 subtitle）。句子 id 在同一集內不可重複。\n- 不要執行渲染、TTS、stills 或任何使用 GPU 的指令；不要修改 GPU 時脈／功耗設定。\n- 不要新增任何上傳或發佈程式碼。\n- 完成後用 3–6 行摘要你改了什麼、為什麼，以及使用者接下來要在 Studio 重跑哪些工作（例如 配音 → 時間軸 → 混音 → 渲染）。\n";

    match task {
        "rewrite_act_pacing" | "improve_anchors" => {
            let sid = opt["sceneId"].as_str().ok_or("請選擇一幕（sceneId）")?;
            let (title, lines) = scene_lines(&seq, sid).ok_or(format!("找不到幕 {sid}"))?;
            if task == "rewrite_act_pacing" {
                p.push_str(&format!("## 任務：重寫 `{sid}`「{title}」的節奏\n"));
                p.push_str("目標：讓這一幕更緊湊、每句只講一個概念，口語自然；保留所有錨點名稱（動畫依賴它們），必要時調整錨點詞與 pauseAfter。");
                p.push_str("可以合併或拆分句子，但新句 id 要沿用 `<幕前綴>-NN` 格式且不重複。\n");
            } else {
                p.push_str(&format!("## 任務：檢查 `{sid}`「{title}」的畫面錨點\n"));
                p.push_str("逐句確認錨點詞是畫面變化的最佳觸發點（名詞被念出的瞬間），錨點詞確實在朗讀文字中，必要時改成更精確的詞。\n");
            }
            p.push_str(&format!("\n目前內容（{} 句）：\n", lines.len()));
            for l in &lines {
                p.push_str(&fmt_line(l));
                p.push('\n');
            }
        }
        "fix_qa_issues" => {
            p.push_str("## 任務：修正品質檢查（QA）發現的問題\n");
            match latest_qa(root) {
                Some((path, text)) => {
                    p.push_str(&format!("最新 QA 報告 `{}`：\n\n```markdown\n{}\n```\n", path.display(), clip(&text, 6000)));
                }
                None => p.push_str("（out/qa/ 沒有報告；請先在 Studio 執行 QA 工作）\n"),
            }
            p.push_str("請區分「設計如此」（例如幕間黑幀轉場、片尾品牌）與真正的問題，只修正真正的問題（字幕過長、旁白內異常靜音、錨點錯位等）。\n");
        }
        "new_episode_script" => {
            let topic = opt["topic"].as_str().filter(|t| !t.trim().is_empty()).ok_or("請輸入主題（topic）")?;
            p.push_str(&format!("## 任務：為新主題撰寫一集腳本\n主題：**{topic}**\n\n"));
            p.push_str("請在 `src/data/narration.json` 的 `sequences` 下新增一個新的 sequence（例如 `ep02`），不要修改既有的 sequence。格式範例（取自現有第一幕的前 3 句）：\n\n```json\n");
            if let Some(first) = scenes.first() {
                let mut ex = first.clone();
                if let Some(ls) = ex["lines"].as_array_mut() {
                    ls.truncate(3);
                }
                p.push_str(&serde_json::to_string_pretty(&ex).unwrap_or_default());
            }
            p.push_str("\n```\n\n要求：冷開場一個好奇問題、5–7 幕、每幕開頭一個問題、每句 ≤ 30 字、專有名詞用 speak 寫出念法、每幕 2–4 個錨點；");
            p.push_str(&format!("參考現有 `{seq_key}` 的語氣與長度（{n_lines} 句）。同時在回覆中列出每一幕需要的畫面元件（之後要寫 act 程式碼）。\n"));
        }
        "fix_failed_job" => {
            p.push_str("## 任務：分析並修正失敗的 Studio 工作\n");
            if let Some(s) = &extra.job_summary {
                p.push_str(&format!("工作摘要：\n{s}\n\n"));
            }
            if let Some(t) = &extra.job_log_tail {
                p.push_str(&format!("工作 log（最後部分）：\n\n```text\n{}\n```\n\n", clip(t, 12000)));
            }
            if let Some((path, text)) = latest_qa(root) {
                p.push_str(&format!("最新 QA 報告 `{}`（參考）：\n\n```markdown\n{}\n```\n\n", path.display(), clip(&text, 3000)));
            }
            p.push_str("請先判斷錯誤類別：內容（錨點、id、TypeScript）→ 直接修正檔案；環境（找不到 ffmpeg/chrome、CUDA、VRAM 不足、網路）→ 不要改程式，說明修復步驟；暫時性 → 建議重試。\n");
        }
        "translate_cn_review" => {
            let sid = opt["sceneId"].as_str().ok_or("請選擇一幕（sceneId）")?;
            let tw = narration::read(root, "zh-TW")?;
            let cn = narration::read(root, "zh-CN")?;
            let pick = |f: &Value| f["sequences"].as_array().and_then(|a| a.iter().find(|s| s["key"] == "ep01").cloned()).and_then(|s| scene_lines(&s, sid));
            let (title, twl) = pick(&tw).ok_or(format!("zh-TW 找不到幕 {sid}"))?;
            let (_, cnl) = pick(&cn).ok_or(format!("zh-CN 找不到幕 {sid}（請先執行 make_cn）"))?;
            p.push_str(&format!("## 任務：審查 `{sid}`「{title}」的 zh-CN 用語\n"));
            p.push_str("zh-CN 由 `scripts/make_cn.py`（OpenCC tw2sp + 用語對照表 PRE + 修正表）自動產生。請找出不自然或誤轉的詞，修正應該加在 `scripts/make_cn.py` 的對照表，而不是直接改 src_cn（會被覆寫）。\n\n| id | zh-TW | zh-CN |\n|---|---|---|\n");
            for l in &twl {
                let id = l["id"].as_str().unwrap_or("");
                let c = cnl.iter().find(|x| x["id"] == id).and_then(|x| x["subtitle"].as_str()).unwrap_or("（缺）");
                p.push_str(&format!("| {id} | {} | {c} |\n", l["subtitle"].as_str().unwrap_or("")));
            }
        }
        t => return Err(format!("unknown task {t}")),
    }
    if let Some(n) = notes {
        p.push_str(&format!("\n## 使用者補充\n{n}\n"));
    }
    p.push_str(rules);
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    #[test]
    fn prompts_use_live_project_data() {
        let r = root();
        if !r.join("src/data/narration.json").exists() {
            return;
        }
        let ex = Extra { job_summary: None, job_log_tail: None };
        let t = build(&r, "rewrite_act_pacing", &json!({"seqKey": "ep01", "sceneId": "act03"}), &ex);
        // scene ids come from the real file; find the first one if act03 doesn't exist
        let t = match t {
            Ok(t) => t,
            Err(_) => {
                let nf = narration::read(&r, "zh-TW").unwrap();
                let sid = nf["sequences"].as_array().unwrap().iter().find(|s| s["key"] == "ep01").unwrap()["scenes"][2]["id"].as_str().unwrap().to_string();
                build(&r, "rewrite_act_pacing", &json!({"seqKey": "ep01", "sceneId": sid}), &ex).unwrap()
            }
        };
        assert!(t.contains("7 幕、75 句"), "{}", &t[..600.min(t.len())]);
        assert!(t.contains("SKILL.md"));
        assert!(t.contains("## 規則"));
        let n = build(&r, "new_episode_script", &json!({"topic": "CPU 快取是什麼"}), &ex).unwrap();
        assert!(n.contains("CPU 快取是什麼") && n.contains("```json"));
        assert!(build(&r, "new_episode_script", &json!({}), &ex).is_err());
        let f = build(&r, "fix_failed_job", &json!({}), &Extra { job_summary: Some("render failed".into()), job_log_tail: Some("區段 0–1799 失敗".into()) }).unwrap();
        assert!(f.contains("區段 0–1799 失敗"));
        assert!(build(&r, "nope", &json!({}), &ex).is_err());
    }
}
