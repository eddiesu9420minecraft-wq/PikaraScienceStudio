//! Prompts for the AI stages (zh-TW; the project Skill has the pipeline details).

use super::*;

// ------------------------------------------------------------------ prompts (zh-TW; the project Skill has the pipeline details)

pub(crate) const COMMON_RULES: &str = "\
共同規則：
- 你在 Pikara Science Studio 的「自動製作」隔離工作樹中執行（目前目錄；外部 Agent 請以任務說明開頭的工作目錄為準）。這是一個 Remotion 科普影片專案；先讀 .claude/skills/pikara-video/SKILL.md 了解管線。
- 不要執行任何 GPU 指令（渲染、stills、CosyVoice、gpu:check），Studio 會排程執行。不要 git commit、不要切換分支、不要安裝套件、不要上傳或發布任何東西。
- 只修改與本集有關的檔案；不要動其他集數的旁白、程式或成品。
- 科學正確性優先：不得虛構數據、規格、測試結果或引文；不確定的內容寧可不寫。
- narration.json 保持 2 空格縮排、UTF-8、不轉義中文，其他鍵的順序不變。
- 完成後用一段簡短的繁體中文說明你做了什麼。";

/// Language rules for narration text (script writer and fixes).
pub(crate) fn lang_rules(p: &Production) -> String {
    let c = &p.config;
    let ep = &p.episode;
    match content::lang(c) {
        "zh-CN" => format!("旁白语言：简体中文，使用中国大陆用语（显存、内存、英伟达、软件、网络、视频…）。这一集的主稿就是简体：直接写在 src/data/narration.json 的 sequences.{ep}（Studio 会原样同步到 src_cn 制作，不会先做繁体版，也不会做繁简转换）。每句字幕 ≤ 36 字。"),
        "en" => format!("Narration language: natural spoken English, written in src/data/narration.json sequences.{ep}. Each subtitle ≤ 90 characters, short spoken sentences. Use `speak` only when TTS could misread something (\"4GB\" → \"four gigabytes\"). Anchor words must appear verbatim (case-insensitive) in speak (or subtitle) and be ≤ 3 words."),
        _ => "旁白語言：繁體中文（台灣用語）。每句字幕 ≤ 36 字。".into(),
    }
}

pub(crate) fn screen_lang(p: &Production) -> &'static str {
    match content::lang(&p.config) {
        "zh-CN" => "畫面上的所有文字使用简体中文（大陆用语）。",
        "en" => "All on-screen text in English.",
        _ => "畫面上的所有文字使用繁體中文。",
    }
}

pub(crate) fn requirements(p: &Production, stage: &str) -> String {
    format!("{}{}", content::brief_block(&p.config, stage), crate::assets::prompt_block(&p.episode, &p.config.assets))
}

pub(crate) fn prompt_script(p: &Production) -> String {
    let c = &p.config;
    let ep = &p.episode;
    let E = ep_upper(ep);
    let en = content::is_en(c);
    let target = (c.minutes * 60.0 * content::rate(c)).round() as i64;
    let unit = if en { "words" } else { "字" };
    let req = requirements(p, "script");
    let min_src = c.min_sources();
    let sources = if min_src == 0 {
        format!("（本集不強制資料來源。若有核對事實，可建立 {E}_SOURCES.md 列出標題與網址；不得編造網址。）")
    } else {
        format!("建立 {E}_SOURCES.md：每個來源列出標題、網址、支持影片中的哪些說法。至少 {min_src} 個真實可開啟的來源，不得編造網址。")
    };
    if content::mode(c) == "script" {
        return format!(
            "任務：整理 {ep} 的旁白（自訂腳本模式）。\n\n主題：{topic}\nStudio 已依使用者的腳本建立 src/data/narration.json 的 sequences.{ep}：每個 scene 是腳本的一個章節，每句 subtitle 是腳本原文（逐句切開）。\n\n{req}\n\
你的工作（只能做這些）：\n\
1. 為每個場景加 2–6 個 anchors（名稱英文小寫，場景內不重複；詞必須逐字出現在該句的 speak 或 subtitle 中，≤ 8 字），動畫會在念到該詞時觸發。\n\
2. 只有在 TTS 可能念錯時才加 speak（例：GPU → G P U、4GB → 四 GB）；speak 必須與 subtitle 意思完全相同。\n\
3. title 若是空的，依腳本內容填一個 12 字內的集名；加上 thumbnail：{{\"lines\": [\"≤8 字\", \"≤8 字\"], \"highlight\": \"≤12 字\", \"tags\": [\"2–5 個短關鍵詞\"]}}。\n\
4. {sources}\n\n\
嚴格禁止：修改任何 subtitle 的文字、增刪或合併句子、增刪或重排場景、改寫腳本內容。腳本若有事實錯誤，不要改，在完成說明中指出。\n{lr}\n\n{COMMON_RULES}",
            topic = c.topic,
            lr = lang_rules(p),
        );
    }
    let chapters_rule = if c.chapters.iter().any(|x| !x.trim().is_empty()) {
        "   - 已指定章節：scenes 的數量、順序與 title 必須與指定章節一致。\n"
    } else {
        "   - 3–7 個場景（章節），每個場景 3–10 句。\n"
    };
    format!(
        "任務：為新的一集 {ep} 完成「資料研究＋劇本」。\n\n\
主題：{topic}\n目標長度：約 {min} 分鐘（旁白約 {target} {unit}；允許 ±15%）\n語氣：{tone}\n觀眾：{aud}\n補充說明：{notes}\n{lr}\n\n{req}\n\
步驟：\n\
1. 用網路搜尋與讀取網頁的工具研究主題，優先官方文件、論文、教科書、權威機構；若有使用者提供的文字／PDF／參考文件，先讀它們，內容以它們為準。{sources}\n\
2. 在 src/data/narration.json 的 sequences 加入 \"{ep}\"（不要修改其他集數）：\n\
   {{\"voiceEngine\": \"cosyvoice\", \"title\": \"<集名，12 字內>\", \"thumbnail\": {{\"lines\": [\"<封面主標第一行，≤8 字>\", \"<第二行，≤8 字>\"], \"highlight\": \"<黃色強調條，≤12 字>\", \"tags\": [\"<2–5 個短關鍵詞>\"]}},\n\
    \"scenes\": [{{\"id\": \"s01\", \"title\": \"<章節標題>\", \"lines\": [{{\"id\": \"{ep}-s01-01\", \"subtitle\": \"<字幕>\", \"speak\": \"<朗讀文字，可省略>\", \"anchors\": {{\"<英文名稱>\": \"<旁白中的詞>\"}}}}]}}]}}\n\
{chapters_rule}\
   - 第一句在 5 秒內提出引人好奇的問題（hook）（有「開場要求」時依要求），最後一個場景收尾並回扣開頭（有「片尾要求」時依要求）。\n\
   - 口語、短句。英文縮寫、數字、單位若 TTS 可能念錯，用 speak 寫出念法（例：subtitle「GPU」→ speak「G P U」；「4GB」→「四 GB」）。\n\
   - anchors：動畫在旁白念到該詞時觸發。詞必須逐字出現在 speak（沒有 speak 則 subtitle）中；每個場景 2–6 個錨點，名稱用英文小寫，場景內不重複；錨點詞簡短（≤ 8 字），會顯示成畫面上的關鍵詞卡片。\n\
   - 「禁止出現的內容」不得出現在任何句子、標題或封面文字中。\n\
3. 確認 JSON 正確且所有錨點詞都在朗讀文字中。\n\n{COMMON_RULES}",
        topic = c.topic,
        min = c.minutes,
        tone = if c.voice_tone.is_empty() { c.tone.clone() } else { format!("{}（配音語氣：{}）", c.tone, c.voice_tone) },
        aud = c.audience,
        notes = if c.notes.is_empty() { "（無）" } else { &c.notes },
        lr = lang_rules(p),
    )
}

pub(crate) fn prompt_animate(p: &Production) -> String {
    let ep = &p.episode;
    let req = requirements(p, "animate");
    format!(
        "任務：為 {ep} 撰寫每個場景的動畫元件（React + TypeScript，Remotion）。\n\n{req}\n\
- 旁白在 src/data/narration.json 的 sequences.{ep}（先讀完）。每個 scene 對應一個元件，建立在 src/acts/{ep}/，檔名用場景 id 的大寫（s01 → S01.tsx；Studio 依檔名做場景級增量渲染），型別是 src/acts/types.ts 的 ActComponent（props：frame 本幕本地影格、anchors 錨點名稱→影格、lines、fps 等）。共用的小元件放 src/acts/{ep}/parts/。\n\
- 在 src/episode/registry.ts 的 CUSTOM_ACTS 標記區塊內加入 {ep}: [{{id: '<scene id>', component: S01, transitionIn: 'self'}}, {{id: …, transitionIn: 'iris'}} …]（第一幕 'self'，其餘 'iris'），id 必須與 scene id 完全相同，順序一致。\n\
- 品質標準＝EP01：2D 圖解＋3D 場景（@remotion/three、three）的高品質科普動畫，不是文字簡報。參考 src/acts/Act02.tsx、src/acts/act02/Datacenter3D.tsx、src/acts/act05/BoardWorld.tsx、src/acts/act06/EmbedWorld.tsx（3D）、src/episode/GenericAct.tsx（錨點驅動的最簡寫法）、src/theme/palette.ts、src/theme/fonts.ts、src/lib/anim.ts。沿用相同的配色、字型與質感；每個場景至少一個能「解釋」概念的視覺（示意動畫、流程、比例、結構、3D 模型），文字卡片只能當輔助。\n\
- {sl}動畫在對應錨點的影格開始（anchors.xxx），沒有寫死的秒數（錨點不存在時要有合理的預設）。動畫節奏配合旁白（有「節奏」要求時依要求）。\n\
- 1920×1080；畫面下方 300px 保留給字幕，不放重要內容；所有文字不得超出畫面或互相重疊；中文字級 ≥ 36px。\n\
- 必須是決定性的：不得使用 Math.random()（請用 src/lib/anim.ts 的 rng(seed)）、Date、網路資源。外部圖片只能用使用者素材（public/user/{ep}/，staticFile 讀取），不得虛構軟體介面截圖。\n\
- 完成後執行 `node node_modules/typescript/bin/tsc --noEmit --pretty false`（在目前目錄直接執行這一行，不要加 cd 或 &&） 直到沒有錯誤。\n\n{COMMON_RULES}",
        sl = screen_lang(p),
    )
}

pub(crate) fn prompt_visual(p: &Production) -> String {
    let ep = &p.episode;
    let files = p.data["stillFiles"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join("\n- ")).unwrap_or_default();
    let nar = if content::cn_only(&p.config) { format!("src/data/narration.json 的 sequences.{ep}（簡體主稿；src_cn 是 Studio 同步的副本，不要改 src_cn）") } else { format!("src/data/narration.json 的 sequences.{ep}") };
    let req = requirements(p, "visual");
    format!(
        "任務：審查 {ep} 的畫面，必要時修正。\n\n{req}\n用 Read 逐一查看這些關鍵幀（1920×1080 PNG，每個場景至少一張；檔名中的數字是 30fps 影格）：\n- {files}\n\n\
檢查：文字是否超出畫面或被裁切、元素互相重疊、內容是否進入下方 300px 字幕區、文字可讀性與對比、空白或破圖、整體美感與風格一致（EP01 等級的 2D＋3D 動畫，不是文字簡報）、圖解是否與旁白內容相符（旁白在 {nar}）、是否違反使用者的製作要求（禁止內容、指定動畫風格）、有使用者素材時是否使用了真實素材而沒有虛構介面。{sl}\n\n\
把結果寫成 JSON 到 out/auto/review.json：{{\"pass\": <沒有 major 問題時 true>, \"issues\": [{{\"file\": \"…\", \"severity\": \"major|minor\", \"problem\": \"…\"}}], \"fixed\": <是否已修改程式或旁白>}}。\n\
如果有 major 問題：修改 src/acts/{ep}/、src/episode/GenericAct.tsx 不可修改（會影響其他集），可以改 narration.json 中 {ep} 的錨點詞讓卡片變短；修改後執行 `node node_modules/typescript/bin/tsc --noEmit --pretty false`（在目前目錄直接執行這一行，不要加 cd 或 &&） 確認沒有錯誤，並把 fixed 設為 true。minor 問題可以順手修正，但不影響 pass。\n\n{COMMON_RULES}",
        sl = screen_lang(p),
    )
}

pub(crate) fn prompt_publish(p: &Production) -> String {
    let ep = &p.episode;
    let E = ep_upper(ep);
    let c = &p.config;
    let lang = content::lang(c);
    let mut thumbs = vec![];
    if lang != "zh-CN" {
        thumbs.push(format!("{E}_YouTube_zh-TW_Thumbnail.png"));
    }
    if content::wants_cn(c) {
        thumbs.push(format!("{E}_Bilibili_zh-CN_Thumbnail.png"));
    }
    let yt = match lang {
        "zh-CN" => String::new(),
        "en" => format!("## YouTube (English): 3 title options (≤ 60 characters), description with chapter timestamps (from {E}.srt), references (from {E}_SOURCES.md if it exists), 10–15 tags.\n"),
        _ => format!(
            "## YouTube（繁體中文）：3 個標題候選（≤ 60 字）、說明欄（含章節時間軸，時間依 {}）、參考資料連結（取自 {E}_SOURCES.md，沒有則省略）、10–15 個標籤。\n",
            if c.youtube { format!("{E}_YouTube_zh-TW.srt 的 1.5× 版本") } else { format!("{E}.srt") }
        ),
    };
    let bili = if content::wants_cn(c) {
        format!("## Bilibili（简体中文，使用大陆用语）：3 个标题候选、简介（含章节时间，依 {E}_Bilibili_zh-CN.srt）、参考资料、分区建议、10–15 个标签。\n")
    } else {
        String::new()
    };
    let req = requirements(p, "publish");
    format!(
        "任務：為 {ep} 撰寫上架資訊（只寫文字檔，不上傳、不發布）。\n\n{req}\n\
讀 src/data/narration.json 的 sequences.{ep}、{E}_SOURCES.md（若有）、字幕檔。用 Read 查看封面 {thumbs}，若主標在 320px 寬縮圖下難以辨識，在檔案最後的「封面檢查」段落說明。\n\n\
建立 {E}_PUBLISH_METADATA.md，包含：\n{yt}{bili}## 封面檢查：一兩句。\n\n內容必須與影片實際旁白一致，不誇大、不使用聳動但不實的標題；不得出現使用者禁止的內容。\n\n{COMMON_RULES}",
        thumbs = thumbs.join("、"),
    )
}

pub(crate) fn prompt_fix(p: &Production, fixer: Fixer, err: &str) -> String {
    let ep = &p.episode;
    let script_mode = content::mode(&p.config) == "script";
    let keep = if script_mode { "（自訂腳本模式：subtitle 是使用者腳本原文，絕對不能改；只能調整 speak、anchors。）" } else { "" };
    let what = match fixer {
        Fixer::Script => format!("旁白（src/data/narration.json 的 sequences.{ep}）或 {}_SOURCES.md 沒有通過檢查。依錯誤修正，保持其他內容不變。{keep}", ep_upper(ep)),
        Fixer::Code => format!("{ep} 的動畫程式（src/acts/{ep}/、src/episode/registry.ts 的 CUSTOM_ACTS）沒有通過檢查。修正到 `node node_modules/typescript/bin/tsc --noEmit --pretty false`（在目前目錄直接執行這一行，不要加 cd 或 &&） 沒有錯誤。"),
        Fixer::Pronunciation => format!(
            "CosyVoice 合成後，Whisper 聽到的讀音與朗讀文字不符（已排除數字寫法與同音字的差異），代表可能念錯或吞字。下面列出每句「應念」與「聽到」。只修正念法：在 src/data/narration.json 的 sequences.{ep} 對這些句子設定或調整 speak 欄位（{}），例如把英文縮寫、數字、符號改寫成念法，或把容易念錯的多音字換成同音字。不要增減或改寫句子的內容；{}錨點詞仍必須出現在 speak 中（必要時一併調整 anchors 的詞）。",
            if content::cn_only(&p.config) { "簡體主稿；Studio 會同步到 src_cn，不要改 src_cn" } else { "主稿" },
            if script_mode { "subtitle 是使用者腳本原文，不能改。" } else { "字幕 subtitle 必須仍與實際念出的內容一致；如果非改寫不可，subtitle 也要改成相同的意思與字數。" }
        ),
        Fixer::Qa => format!(
            "{ep} 的成品沒有通過自動 QA（黑畫面、音量、靜音、字幕重疊等）。讀 out/qa/ 下的報告，找出原因並修正 src/acts/{ep}/ 或 narration.json 的 sequences.{ep}（例如調整 pauseAfter、拆句）。{}若問題無法以修改內容解決，說明原因即可。{keep}",
            if content::cn_only(&p.config) { "簡體主稿在 src/data/narration.json（src_cn 由 Studio 同步產生，不要改 src_cn）。" } else { "簡體版的旁白在 src_cn/data/narration.json（src_cn 的程式會由 make_cn 從 src 重新產生，不要改 src_cn 的程式碼）。" }
        ),
        Fixer::None => String::new(),
    };
    format!(
        "任務：修正自動製作中失敗的步驟「{}」（第 {} 次嘗試失敗）。\n\n{what}\n\n{}\n錯誤與日誌摘錄：\n```\n{}\n```\n\n{COMMON_RULES}",
        stage_label_for(&p.stage, &p.config),
        p.attempt.saturating_sub(1).max(1),
        requirements(p, "fix"),
        clip(err, 6000)
    )
}

pub(crate) fn clip(s: &str, n: usize) -> String {
    let c: Vec<char> = s.chars().collect();
    if c.len() <= n { s.to_string() } else { c[c.len() - n..].iter().collect() }
}
