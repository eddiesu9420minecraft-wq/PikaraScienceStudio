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

/// 專案裡可用的參考人聲（tools/CosyVoice/reference/*.wav，需有同名 .txt 逐字稿；reference 是旁白本身）。
pub fn voice_refs(root: &Path) -> Vec<String> {
    let dir = root.join("tools").join("CosyVoice").join("reference");
    let mut v: Vec<String> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let p = e.path();
                    let stem = p.file_stem()?.to_str()?.to_string();
                    (p.extension().is_some_and(|x| x == "wav") && stem != "reference" && p.with_extension("txt").exists()).then_some(stem)
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

/// 擬人化科普（敘事與角色）：劇本階段決定要不要用角色、寫角色設定與對白；動畫階段依同一份設定畫角色。
/// 參考：EP10「GPU 為什麼不能取代 CPU？」用 CPU／GPU／RAM 三個晶片角色的對白與互動解釋分工。
pub(crate) fn narrative_block(p: &Production, voices: &[String], stage: &str) -> String {
    let c = &p.config;
    let ep = &p.episode;
    let mode = c.narrative_mode();
    if mode == "plain" {
        return if stage == "script" { "敘事方式：一般旁白，不使用擬人化角色。\n".into() } else { String::new() };
    }
    let given = if c.characters.is_empty() {
        String::new()
    } else {
        let list = c
            .characters
            .iter()
            .map(|x| {
                format!(
                    "  - {}（代表：{}）外觀：{}；性格：{}；人聲：{}{}",
                    if x.name.is_empty() { &x.concept } else { &x.name },
                    if x.concept.is_empty() { "—" } else { &x.concept },
                    if x.look.is_empty() { "由你設計" } else { &x.look },
                    if x.personality.is_empty() { "由你設計" } else { &x.personality },
                    if x.voice.is_empty() { "旁白人聲" } else { &x.voice },
                    if x.pitch != 0.0 { format!("，音高 {:+} 半音", x.pitch) } else { String::new() }
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!("使用者指定的角色（必須沿用名稱與設定，可補充細節）：\n{list}\n")
    };
    let voices_txt = if voices.is_empty() { "（專案沒有額外的參考人聲，voice 請留空，用 pitch 區分角色）".to_string() } else { voices.join("、") };
    match stage {
        "script" => {
            let decide = if mode == "personified" {
                "這一集**必須**使用擬人化角色。".to_string()
            } else {
                "先判斷這個主題是否適合擬人化：有兩個以上會「互動、分工、競爭或傳遞東西」的技術概念（例：CPU 與 GPU、客戶端與伺服器、封包與路由器）就適合；純歷史敘事、單一抽象定義、嚴肅安全議題則不適合，用一般旁白即可。適合時才使用角色，並在完成說明寫出你的判斷理由。".to_string()
            };
            format!(
                "## 敘事方式：擬人化科普（參考 EP10「GPU 為什麼不能取代 CPU？」）\n{decide}\n{given}\
使用角色時：\n\
- 在 sequences.{ep} 加上 \"characters\": [{{\"id\": \"<英文小寫>\", \"name\": \"<角色名>\", \"concept\": \"<代表的技術概念>\", \"look\": \"<外觀：主色、形狀、配件，動畫依此繪製>\", \"personality\": \"<性格與說話方式>\", \"voice\": \"<參考人聲，可留空>\", \"pitch\": <半音 -6～6>}}]，2–4 個角色。可用的參考人聲：{voices_txt}。不同角色的 voice／pitch 組合必須不同，讓觀眾聽得出是誰在說話（例：沉穩的角色 pitch -2，活潑的角色 +3）。\n\
- 角色說的台詞用獨立的一句，加上 \"speaker\": \"<角色 id>\"；字幕 subtitle 只寫台詞本身（不要加「CPU：」前綴）。沒有 speaker 的句子是旁白。旁白仍要負責解釋與總結，對白比例約 30–60%。\n\
- 角色的個性要符合它代表的技術特性（例：CPU 精明、多才多藝但人手少；GPU 人多力大但只會做重複的事），用對白、吐槽、誤會與合作來呈現原理；比喻不能扭曲事實，最後用旁白把比喻對回真實技術。\n\
- 用 anchors 標出角色的關鍵動作或表情時機（例：\"gpu_jump\": \"一腳踹開\"），動畫會在念到時觸發。\n"
            )
        }
        "animate" => format!(
            "## 擬人化角色（若 sequences.{ep}.characters 存在）\n\
- 先在 src/acts/{ep}/parts/characters.tsx 建立共用的角色元件（每個角色一個，依 characters 的 look 繪製：固定主色、輪廓、五官與配件），所有場景都使用同一個元件，確保外觀一致。可參考 src/acts/ep10/parts/common.tsx 的 Mascot、Bubble（若專案中存在）。\n\
- 角色元件要支援表情（開心、得意、驚訝、生氣、沮喪、思考）與肢體動作（揮手、跳起、指向、搖頭、倒下、互相推擠），用 props 控制，動作以 spring／緩動呈現，不要生硬切換。\n\
- 角色說話的句子（speaker）要讓說話者有嘴部或身體的說話動畫，並用對話氣泡顯示重點詞（氣泡不可壓到字幕區）；其他角色同時要有反應（點頭、驚訝、吐槽）。\n\
- 加入符合技術原理的趣味互動（例：GPU 一次搬一大堆箱子、CPU 拿著清單指揮），但互動必須能解釋概念，不是純裝飾。\n\
- 角色出現時仍要有能「解釋」概念的圖解或 3D 場景，角色是引導觀眾的主角，不是唯一的畫面。\n"
        ),
        _ => String::new(),
    }
}

pub(crate) fn prompt_script(p: &Production) -> String {
    let c = &p.config;
    let ep = &p.episode;
    let E = ep_upper(ep);
    let en = content::is_en(c);
    let target = (c.minutes * 60.0 * content::rate(c)).round() as i64;
    let unit = if en { "words" } else { "字" };
    let req = requirements(p, "script");
    let voices: Vec<String> = p.data["voiceRefs"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
    let nar = narrative_block(p, &voices, "script");
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
4. {sources}\n\
5. 擬人化（依下方「敘事方式」）：可以在 sequences.{ep} 加上 characters，並為角色說的句子加上 speaker；不得為此修改 subtitle。\n\n{nar}\n\
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
主題：{topic}\n目標長度：約 {min} 分鐘（旁白約 {target} {unit}；允許 ±15%）\n語氣：{tone}\n觀眾：{aud}\n補充說明：{notes}\n{lr}\n\n{req}\n{nar}\n\
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
    let nar = narrative_block(p, &[], "animate");
    format!(
        "任務：為 {ep} 撰寫每個場景的動畫元件（React + TypeScript，Remotion）。\n\n{req}\n{nar}\
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
        Fixer::Script => format!(
            "旁白（src/data/narration.json 的 sequences.{ep}）或 {}_SOURCES.md 沒有通過檢查。**只修正下面標示「失敗」的項目**（「警告」可視情況處理）：\
             不要重新做研究、不要刪除或重寫 {}_SOURCES.md、不要改寫已通過的句子與場景，只做讓失敗項目通過的最小修改。\
             檢查已比對繁簡字、兩岸用語、同義詞、大小寫與標點，所以只要實際內容表達了要求就會通過，不需要逐字照抄要求的寫法。{}{keep}",
            ep_upper(ep),
            ep_upper(ep),
            if content::cn_only(&p.config) { "這是僅簡體中文的影片：標題與字幕一律使用簡體字與中國大陸用語（例如「兼容」「用户界面」「位」），使用者用繁體寫的要求代表同樣的內容，**不要把標題或句子改成繁體字**。" } else { "" }
        ),
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
