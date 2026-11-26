//! Inline (non-job) stage actions and their check results.

use super::*;

impl Autopilot {
    // -------------------------------------------------------------- inline actions

    pub(crate) fn inline(&self, p: &mut Production, name: &str) -> Result<(), Check> {
        let root = self.root(p).map_err(Check::Hard)?;
        let wt = p.worktree.as_deref().map(|w| worktree_dir(&root, w));
        let E = ep_upper(&p.episode);
        match name {
            "prepare" => {
                let w = p.worktree.clone().unwrap_or_else(|| format!("auto-{}-{}", p.episode, &p.id[..8]));
                let br = format!("studio/auto/{}-{}", p.episode, &p.id[..8]);
                let info = prepare_worktree(&root, &w, &br).map_err(Check::Hard)?;
                let wtp = worktree_dir(&root, &w);
                p.worktree = Some(w);
                p.branch = Some(br);
                self.log(p, "info", &info);
                if p.data["baseSha"].is_null() {
                    if let Ok(o) = git(&wtp, &["rev-parse", "HEAD"]) {
                        p.data["baseSha"] = json!(o.stdout.trim());
                    }
                }
                // requirements and material where every agent (Claude, 豆包, external) can read them
                let _ = std::fs::create_dir_all(wtp.join("out/auto"));
                let _ = std::fs::write(wtp.join("out/auto/BRIEF.md"), content::brief_markdown(&p.config, &p.episode));
                if !p.config.assets.is_empty() {
                    let adir = crate::layout::video_dir(&root, &p.episode).join("assets");
                    crate::assets::link(&wtp, &p.episode, &adir).map_err(Check::Hard)?;
                    let md = crate::assets::manifest(&wtp, &p.episode, &p.config.assets);
                    let frames = md.matches("asset_frames/").count();
                    self.log(p, "info", &format!("素材 {} 個已連結到 public/user/{}；清單 out/auto/ASSETS.md{}", p.config.assets.len(), p.episode, if frames > 0 { format!("，擷取 {frames} 張影片關鍵幀") } else { String::new() }));
                }
                Ok(())
            }
            "import_script" => {
                let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                let en = content::is_en(&p.config);
                let (title, scenes) = content::parse_script(&p.config.script_text, en, &p.config.chapters);
                if scenes.is_empty() {
                    return Err(Check::Hard("自訂腳本沒有任何內容可以匯入".into()));
                }
                let title = title.unwrap_or_else(|| p.config.topic.chars().take(24).collect());
                let seq = content::script_to_seq(&p.episode, &title, &scenes);
                let path = crate::narration::file_path(&wt, "zh-TW").map_err(Check::Hard)?;
                let raw = std::fs::read_to_string(&path).map_err(|e| Check::Hard(e.to_string()))?;
                let mut doc: Value = serde_json::from_str(raw.trim_start_matches('\u{feff}')).map_err(|e| Check::Hard(e.to_string()))?;
                if doc["sequences"].get(&p.episode).is_none() || p.data["scriptImported"].as_bool() != Some(true) {
                    doc["sequences"][&p.episode] = seq;
                    std::fs::write(&path, crate::narration::serialize_like(&doc, &raw).map_err(Check::Hard)?).map_err(|e| Check::Hard(e.to_string()))?;
                    p.data["scriptImported"] = json!(true);
                }
                let n: usize = scenes.iter().map(|s| s.1.len()).sum();
                self.log(p, "info", &format!("已匯入使用者腳本：{} 個章節、{n} 句（逐字使用，AI 只補錨點、念法與標題）", scenes.len()));
                Ok(())
            }
            "check_script" => {
                let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                let c = &p.config;
                let script_mode = content::mode(c) == "script";
                let target = c.minutes * 60.0 * content::rate(c);
                let r = check_script(&wt, &p.episode, &ScriptRules { target_units: target, words: content::is_en(c), check_length: !script_mode, min_sources: c.min_sources() }).map_err(Check::Fail)?;
                let doc = crate::narration::read(&wt, "zh-TW").map_err(Check::Hard)?;
                let seq = doc["doc"]["sequences"][&p.episode].clone();
                if script_mode {
                    content::fidelity(&c.script_text, &seq, content::is_en(c)).map_err(Check::Fail)?;
                }
                let notes = content::check_requirements(c, &seq).map_err(Check::Fail)?;
                self.log(p, "info", &format!("{r}{}{}", if script_mode { "；字幕與使用者腳本逐字相符" } else { "" }, if notes.is_empty() { String::new() } else { format!("；{}", notes.join("；")) }));
                Ok(())
            }
            "check_animate" => {
                let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                let reg = std::fs::read_to_string(wt.join("src/episode/registry.ts")).unwrap_or_default();
                if !Regex::new(&format!(r"(?m)^\s*{}\s*:", p.episode)).unwrap().is_match(&reg) {
                    return Err(Check::Fail(format!("src/episode/registry.ts 的 CUSTOM_ACTS 裡沒有 {}。", p.episode)));
                }
                Ok(())
            }
            "check_voice" => {
                if !p.config.pronunciation_check {
                    return Ok(());
                }
                let jid = p.data["lastJob"].as_str().unwrap_or("").to_string();
                let evs = db::events_list(&self.conn(), &jid, 0, 1_000_000).unwrap_or_default();
                let raw = bad_pronunciations(evs.iter().map(|e| e.line.as_str()), 0.15);
                // Raw CER also counts digits vs Chinese numerals and homophones written with other characters
                // ("16" vs 十六, 他/它, 占/站). Re-check those lines by pronunciation: pinyin error rate.
                let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                let dir = wt.join(if content::cn_only(&p.config) { "public/assets/audio/voiceover_cosy_cn" } else { "public/assets/audio/voiceover_cosy" }).join(&p.episode);
                let mut bad = vec![];
                let mut ok_after = 0;
                if content::is_en(&p.config) {
                    // English: no pinyin comparison; the character error rate of the letters is the measure
                    for (id, cer, _) in &raw {
                        let v: Value = std::fs::read_to_string(dir.join(format!("{id}.json"))).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
                        bad.push(format!("{id}  CER {cer:.3}\n    應念：{}\n    聽到：{}", v["speak"].as_str().unwrap_or(""), v["alignment"]["asr"].as_str().unwrap_or("")));
                    }
                    if bad.is_empty() {
                        self.log(p, "info", "發音檢查通過（英文，Whisper 字元錯誤率 ≤ 0.15）");
                        return Ok(());
                    }
                    p.data["badLines"] = json!(raw.iter().map(|r| r.0.clone()).collect::<Vec<_>>());
                    return Err(Check::Fail(format!("{} 句讀音可能有誤（字元錯誤率 > 0.15）：\n{}", bad.len(), bad.join("\n"))));
                }
                for (id, cer, _) in &raw {
                    let v: Value = std::fs::read_to_string(dir.join(format!("{id}.json"))).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
                    let speak = v["speak"].as_str().unwrap_or("");
                    let asr = v["alignment"]["asr"].as_str().unwrap_or("");
                    if speak.is_empty() || asr.is_empty() {
                        bad.push(format!("{id}  CER {cer:.3}（沒有辨識結果可比對）"));
                        continue;
                    }
                    // ttsText = what the pronunciation dictionary sent to TTS (CUDA → 酷達); subtitle = the written form
                    // (speak「C plus plus」, subtitle「C++」— Whisper writes c++). Any of the three readings counts as correct.
                    let tts = v["ttsText"].as_str().filter(|t| !t.is_empty()).unwrap_or(speak);
                    let sub = v["subtitle"].as_str().filter(|t| !t.is_empty()).unwrap_or(speak);
                    let per = pron_error(speak, asr).min(pron_error(tts, asr)).min(pron_error(sub, asr));
                    if per > MAX_PER {
                        bad.push(format!("{id}  讀音錯誤率 {per:.3}（CER {cer:.3}）\n    應念：{speak}\n    聽到：{asr}"));
                    } else {
                        ok_after += 1;
                    }
                }
                let ids: Vec<String> = bad.iter().map(|b| b.split_whitespace().next().unwrap_or("").to_string()).collect();
                if bad.is_empty() {
                    self.log(p, "info", &format!("發音檢查通過（{ok_after} 句的字元差異只是數字寫法或同音字，讀音相符）"));
                    return Ok(());
                }
                p.data["badLines"] = json!(ids);
                Err(Check::Fail(format!("{} 句讀音可能有誤（拼音比對錯誤率 > {MAX_PER}）：\n{}", bad.len(), bad.join("\n"))))
            }
            "plan_stills" => {
                let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                let frames = still_frames(&wt, &p.episode, if content::cn_only(&p.config) { "src_cn" } else { "src" }).map_err(Check::Hard)?;
                let comp = format!("{E}-30fps");
                let _ = std::fs::remove_dir_all(wt.join("out/stills"));
                let _ = std::fs::remove_file(wt.join("out/auto/review.json"));
                p.data["stillFrames"] = json!(frames.iter().map(|f| f.to_string()).collect::<Vec<_>>().join(","));
                p.data["stillFiles"] = json!(frames.iter().map(|f| format!("out/stills/{comp}-{f:05}.png")).collect::<Vec<_>>());
                Ok(())
            }
            "check_visual" => {
                let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                let v: Value = std::fs::read_to_string(wt.join("out/auto/review.json"))
                    .ok()
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .ok_or(Check::Retry("審查沒有寫出 out/auto/review.json，重新審查".into()))?;
                let issues: Vec<String> = v["issues"].as_array().cloned().unwrap_or_default().iter().map(|i| format!("[{}] {} {}", i["severity"].as_str().unwrap_or("?"), i["file"].as_str().unwrap_or(""), i["problem"].as_str().unwrap_or(""))).collect();
                let _ = std::fs::create_dir_all(wt.join("out/auto"));
                let _ = std::fs::copy(wt.join("out/auto/review.json"), wt.join(format!("out/auto/review_{}.json", p.attempt)));
                let major = v["issues"].as_array().map(|a| a.iter().any(|i| i["severity"] == "major")).unwrap_or(false);
                let fixed = v["fixed"].as_bool().unwrap_or(false);
                // a major issue that was fixed in code must be looked at again on freshly rendered stills
                if v["pass"].as_bool().unwrap_or(false) && !(major && fixed) {
                    self.log(p, "info", &format!("畫面審查通過（{} 個次要問題）", issues.len()));
                    return Ok(());
                }
                let msg = format!("畫面審查發現問題{}：{}", if v["fixed"].as_bool().unwrap_or(false) { "，已修改程式，重新檢查" } else { "" }, issues.join("；"));
                if v["fixed"].as_bool().unwrap_or(false) {
                    Err(Check::Retry(msg))
                } else {
                    Err(Check::Fail(msg))
                }
            }
            "check_qa" => {
                let jid = p.data["lastJob"].as_str().unwrap_or("").to_string();
                let evs = db::events_list(&self.conn(), &jid, 0, 1_000_000).unwrap_or_default();
                match qa_problems(evs.iter().map(|e| e.line.as_str())) {
                    Some(0) => {
                        self.log(p, "info", "自動 QA：0 項問題");
                        Ok(())
                    }
                    Some(n) => {
                        let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                        let report = latest_qa_report(&wt);
                        Err(Check::Fail(format!("自動 QA 檢出 {n} 項問題。\n{report}")))
                    }
                    None => Err(Check::Fail("找不到 QA 結果（qa_video.py 沒有輸出問題數）".into())),
                }
            }
            "copy_thumb_tw" | "copy_thumb_cn" => {
                let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                let src = wt.join(format!("out/stills/{E}-Thumbnail-00000.png"));
                let dst = wt.join(if name == "copy_thumb_tw" { format!("{E}_YouTube_zh-TW_Thumbnail.png") } else { format!("{E}_Bilibili_zh-CN_Thumbnail.png") });
                std::fs::copy(&src, &dst).map_err(|e| Check::Fail(format!("封面沒有產生（{}）：{e}", clean_path(&src))))?;
                if name == "copy_thumb_tw" && !p.config.bilibili {
                    let _ = std::fs::copy(&src, wt.join(format!("{E}_Thumbnail.png")));
                }
                Ok(())
            }
            "check_publish" => {
                let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                let f = wt.join(format!("{E}_PUBLISH_METADATA.md"));
                match std::fs::read_to_string(&f) {
                    Ok(s) if (s.contains("YouTube") || s.contains("Bilibili")) && s.chars().count() > 200 => Ok(()),
                    _ => Err(Check::Fail(format!("{E}_PUBLISH_METADATA.md 沒有寫出或內容不完整"))),
                }
            }
            "deliver" => {
                let wt = wt.ok_or(Check::Hard("沒有工作樹".into()))?;
                let (outputs, merged, note) = deliver(&root, &wt, p).map_err(Check::Hard)?;
                p.outputs = outputs;
                self.log(p, if merged { "info" } else { "warn" }, &note);
                if merged {
                    let w = p.worktree.clone().unwrap_or_default();
                    match remove_worktree(&root, &w, !crate::layout::is_test(&p.episode)) {
                        Ok(()) => p.worktree = None,
                        Err(e) => self.log(p, "warn", &format!("工作樹清除失敗（可稍後按「捨棄」）：{e}")),
                    }
                } else {
                    p.message = Some(note);
                }
                Err(Check::Done(merged))
            }
            other => Err(Check::Hard(format!("unknown inline action {other}"))),
        }
    }
}

pub(crate) enum Check {
    /// fixable failure (fix job, then the stage re-runs)
    Fail(String),
    /// environment / internal failure (re-run without a fix job)
    Hard(String),
    /// the reviewer already changed files: re-run the stage
    Retry(String),
    /// production finished (merged or needs manual merge)
    Done(bool),
}
