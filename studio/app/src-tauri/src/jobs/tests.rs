//! Unit tests for job kinds, command building and progress parsing.

use super::*;

const RENDER_LOG: &str = "GPU：ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)
渲染 EP01-30fps：25257 幀，15 段（每段 1800 幀），GPU：ANGLE / D3D11；VRAM 基準 1120 MiB，上限 5300 MiB
  區段 0–1799：已完成，略過
  區段 1800–3599：61s，29.5 fps，並行 6，GPU 平均 96%，VRAM 峰值 5012 MiB，最高 49°C
  區段 3600–5399：58s，31.0 fps，並行 6，GPU 平均 97%，VRAM 峰值 5101 MiB，最高 49°C，⚠ 熱降頻
混音已完成，開始編碼

完成：EP01_Final.mp4（812.3 MB）";

#[test]
fn render_progress_from_real_log_format() {
    let mut st = ParseState::default();
    let outs: Vec<ParseOut> = RENDER_LOG.lines().map(|l| parse_line(Parser::Render, &mut st, l)).collect();
    assert_eq!(outs[1].progress, Some(0.0));
    let p2 = outs[2].progress.unwrap();
    assert!((p2 - 0.9 * 1800.0 / 25257.0).abs() < 1e-9);
    let p4 = outs[4].progress.unwrap();
    assert!((p4 - 0.9 * 5400.0 / 25257.0).abs() < 1e-9);
    assert_eq!(outs[4].level, Some("warn"));
    assert_eq!(outs[4].text.as_deref(), Some("區段 3600–5399（5400/25257 幀）"));
    assert_eq!(outs[5].progress, Some(0.92));
    assert_eq!(outs[7].progress, Some(1.0));
    let mut st2 = ParseState::default();
    assert_eq!(parse_line(Parser::Render, &mut st2, "區段 0–1799 失敗。已完成的區段都保留").level, Some("error"));
    assert!(parse_line(Parser::Render, &mut st2, "Rendered 450/1800").progress.unwrap() > 0.2);
    // v0.2.2: render.mjs names the real encoder (any vendor) and reports fallbacks
    let e = parse_line(Parser::Render, &mut st2, "編碼中：h264_amf");
    assert_eq!((e.progress, e.text.as_deref()), (Some(0.92), Some("編碼中（h264_amf）")));
    assert_eq!(parse_line(Parser::Render, &mut st2, "編碼中").text.as_deref(), Some("編碼中"));
}

#[test]
fn voice_progress() {
    let mut st = ParseState::default();
    let l = ["共 75 句，需要產生 2 句 → public/assets/audio/voiceover_cosy/ep01",
        "模型載入 31.2s，precision=fp16，VRAM 2100 MiB",
        "  ✓ 10:01:02 a1-00 audio=5.70s wall=6.1s RTF=1.07 peakVRAM=3300MiB gpu[util,mem,temp]=90 %, 3300 MiB, 60",
        "  ✗ a1-01 失敗：RuntimeError: boom",
        "對齊 2 句（faster-whisper large-v3-turbo，CPU int8）",
        "  ≡ a1-00 對上 20/20 字  CER 0.000",
        "  ≡ a1-01 對上 18/20 字  CER 0.100",
        "完成：75/75 句有音檔，0 句缺少邊界。"];
    let o: Vec<ParseOut> = l.iter().map(|x| parse_line(Parser::Voice, &mut st, x)).collect();
    assert_eq!(o[0].progress, Some(0.0));
    assert_eq!(o[2].progress, Some(0.425));
    assert_eq!(o[3].level, Some("error"));
    assert_eq!(o[4].progress, Some(0.85));
    assert!((o[6].progress.unwrap() - 1.0).abs() < 1e-9);
    assert_eq!(o[7].progress, Some(1.0));
}

#[test]
fn claude_stream_json_summaries() {
    let mut st = ParseState::default();
    let a = parse_line(Parser::Claude, &mut st, r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Looking at act 3"},{"type":"tool_use","name":"Read","input":{"file_path":"src/data/narration.json"}}]}}"#);
    let d = a.display.unwrap();
    assert_eq!(d[0], "Claude: Looking at act 3");
    assert!(d[1].starts_with("[tool] Read"));
    let r = parse_line(Parser::Claude, &mut st, r#"{"type":"result","subtype":"success","is_error":false,"num_turns":3,"total_cost_usd":0.0123,"result":"Done."}"#);
    assert_eq!(r.progress, Some(1.0));
    assert!(r.display.unwrap()[0].contains("cost=$0.0123"));
    assert_eq!(parse_line(Parser::Claude, &mut st, "not json"), ParseOut::default());
}

#[test]
fn steps_map_to_real_pipeline_commands() {
    let s = Settings::default();
    let tmp = std::env::temp_dir();
    let root = tmp.as_path();
    let ctx = Ctx { root, settings: &s, job_id: "j1" };
    let b = build_steps("bilibili", &json!({}), &ctx).unwrap();
    let labels: Vec<&str> = b.iter().map(|x| x.label.as_str()).collect();
    assert_eq!(labels.len(), 7, "{labels:?}");
    assert!(b[0].args.contains(&"scripts/make_cn.py".to_string()));
    assert!(b[1].args.iter().any(|a| a == "src_cn/data/narration.json"));
    assert!(b[1].env.iter().any(|(k, v)| k == "PIKARA_ASR_CC" && v == "t2s"));
    assert!(b[5].args.windows(2).any(|w| w[0] == "--src" && w[1] == "src_cn"));
    assert_eq!(b[5].parser, Parser::Render);
    assert!(b[6].args.contains(&"EP01_Bilibili_zh-CN.mp4".to_string()));
    let y = build_steps("youtube_15x", &json!({}), &ctx).unwrap();
    assert_eq!(y[0].args, pyargs(&["-u", "scripts/scale_srt.py", "EP01.srt", "EP01_YouTube_zh-TW.srt", "1.5"]));
    assert!(y[1].args.contains(&"EP01-YT15".to_string()));
    let r = build_steps("render", &json!({"comp": "EP01-30fps", "out": "X.mp4", "src": "src_cn", "frames": "0-99"}), &ctx).unwrap();
    assert_eq!(r[0].args, vec!["scripts/render.mjs", "gpu", "--comp", "EP01-30fps", "--out", "X.mp4", "--src", "src_cn", "--frames", "0-99"]);
    // injection guards
    assert!(build_steps("render", &json!({"out": "..\\evil.mp4"}), &ctx).is_err());
    assert!(build_steps("render", &json!({"comp": "--browser-executable=x"}), &ctx).is_err());
    assert!(build_steps("voiceover_tw", &json!({"only": "a1-00 --ref x"}), &ctx).is_err());
    assert!(build_steps("doctor_fix", &json!({"fixId": "pip_install:evil;rm"}), &ctx).is_err());
    let v = build_steps("voiceover_tw", &json!({"only": "a1-00 a4-15", "force": true}), &ctx).unwrap();
    assert!(v[0].args.ends_with(&["--only".into(), "a1-00".into(), "a4-15".into(), "--force".into()]));
    assert_eq!(resource_for("render", &json!({})).unwrap(), "gpu");
    assert_eq!(resource_for("qa", &json!({})).unwrap(), "cpu");
    assert_eq!(resource_for("custom", &json!({"gpu": true})).unwrap(), "gpu");
}

#[test]
fn episode_parameter_drives_commands_and_output_names() {
    let s = Settings::default();
    let tmp = std::env::temp_dir();
    let ctx = Ctx { root: tmp.as_path(), settings: &s, job_id: "j2" };
    // defaults stay EP01 (v1 behaviour unchanged)
    let r = build_steps("render", &json!({}), &ctx).unwrap();
    assert_eq!(r[0].args, vec!["scripts/render.mjs", "gpu", "--comp", "EP01-30fps", "--out", "EP01_Final.mp4"]);
    // ep02 → EP02-* everywhere
    let r = build_steps("render", &json!({"episode": "ep02", "chunk": 120}), &ctx).unwrap();
    assert_eq!(r[0].args, vec!["scripts/render.mjs", "gpu", "--comp", "EP02-30fps", "--out", "EP02_Final.mp4", "--chunk", "120"]);
    let q = build_steps("qa", &json!({"episode": "ep03"}), &ctx).unwrap();
    assert_eq!(q[0].args, pyargs(&["-u", "scripts/qa_video.py", "EP03_Final.mp4", "--seq", "ep03"]));
    let v = build_steps("voiceover_cn", &json!({"episode": "ep02"}), &ctx).unwrap();
    assert!(v[0].args.windows(2).any(|w| w[0] == "--seq" && w[1] == "ep02"));
    let b = build_steps("bilibili", &json!({"episode": "ep02"}), &ctx).unwrap();
    assert_eq!(b[0].args, pyargs(&["-u", "scripts/make_cn.py", "--seq", "ep02"]));
    assert!(b[2].args.windows(2).any(|w| w[0] == "--srt-name" && w[1] == "ep02_cn"));
    assert!(b[3].args.contains(&crate::platform::native("out/subtitles/ep02_cn.srt")) && b[3].args.contains(&"EP02_Bilibili_zh-CN.srt".to_string()));
    assert!(b[4].args.windows(2).any(|w| w[0] == "--mix-name" && w[1] == "ep02_cn"));
    assert!(b[5].args.windows(2).any(|w| w[0] == "--comp" && w[1] == "EP02-30fps") && b[5].args.contains(&"EP02_Bilibili_zh-CN.mp4".to_string()));
    assert!(b[6].args.windows(2).any(|w| w[0] == "--seq" && w[1] == "ep02"));
    let y = build_steps("youtube_15x", &json!({"episode": "ep02"}), &ctx).unwrap();
    assert_eq!(y[0].args, pyargs(&["-u", "scripts/scale_srt.py", "EP02.srt", "EP02_YouTube_zh-TW.srt", "1.5"]));
    assert!(y[1].args.contains(&"EP02-YT15".to_string()) && y[1].args.contains(&"EP02_YouTube_zh-TW.mp4".to_string()));
    let f = build_steps("final_tw", &json!({"episode": "ep02"}), &ctx).unwrap();
    let fl: Vec<&str> = f.iter().map(|x| x.label.as_str()).collect();
    assert_eq!(fl, vec!["時間軸 EP02", "複製字幕", "混音 EP02", "渲染 EP02-30fps", "品質檢查 EP02"]);
    assert!(f[1].args.contains(&crate::platform::native("out/subtitles/ep02.srt")) && f[1].args.contains(&"EP02.srt".to_string()));
    let m = build_steps("make_cn", &json!({"episode": "ep02", "reconvert": true}), &ctx).unwrap();
    assert_eq!(m[0].args, pyargs(&["-u", "scripts/make_cn.py", "--seq", "ep02", "--reconvert"]));
    assert_eq!(build_steps("make_cn", &json!({}), &ctx).unwrap()[0].args, pyargs(&["-u", "scripts/make_cn.py"]));
    // v1 `seq` still accepted; bad ids refused with a zh-TW message
    let t = build_steps("timeline", &json!({"seq": "ep02"}), &ctx).unwrap();
    assert!(t[0].args.windows(2).any(|w| w[0] == "--seq" && w[1] == "ep02"));
    assert!(build_steps("timeline", &json!({"seq": "arttest"}), &ctx).is_ok());
    // narration pace: settings value goes to every step as PIKARA_VOICE_TEMPO; a job param adds --voice-tempo (snapped to a preset)
    assert!(t[0].env.iter().any(|(k, v)| k == "PIKARA_VOICE_TEMPO" && v == "1"));
    assert!(!t[0].args.contains(&"--voice-tempo".to_string()));
    let tt = build_steps("timeline", &json!({"episode": "ep02", "src": "src_cn", "voiceTempo": 1.13}), &ctx).unwrap();
    assert!(tt[0].args.windows(2).any(|w| w[0] == "--voice-tempo" && w[1] == "1.1"), "{:?}", tt[0].args);
    for bad in ["ep2", "EP02x", "ep02 --force", "../ep02", "ep02;del"] {
        let e = build_steps("render", &json!({"episode": bad}), &ctx).unwrap_err();
        assert!(e.contains("集數 id 不正確"), "{bad}: {e}");
    }
    assert_eq!(label_for("bilibili", &json!({"episode": "ep02"})), "EP02 · Bilibili zh-CN 全流程");
    assert_eq!(label_for("render", &json!({"episode": "ep03"})), "渲染 EP03-30fps → EP03_Final.mp4");
}

#[test]
fn voice_tempo_presets_snap() {
    use super::steps::voice_tempo_preset as v;
    assert_eq!(v(1.0), 1.0);
    assert_eq!(v(0.9), 0.9);
    assert_eq!(v(1.2), 1.2);
    assert_eq!(v(1.66), 1.2); // never beyond the fastest preset
    assert_eq!(v(0.5), 0.9);
    assert_eq!(v(f64::NAN), 1.0);
    assert_eq!(v(0.0), 1.0);
    assert_eq!(v(-1.0), 1.0);
}

#[test]
fn preflight_gives_friendly_messages() {
    let s = Settings::default();
    let d = std::env::temp_dir().join(format!("pss 預檢 {}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(d.join("src").join("data")).unwrap();
    std::fs::write(d.join("src").join("data").join("narration.json"), r#"{"sequences":{"ep01":{"scenes":[]},"ep02":{"scenes":[]}}}"#).unwrap();
    let all = |_: &str| true;
    let no_probe = |t: &str| t != "ffprobe";
    // ffprobe missing → job never starts, message says what to install
    let e = preflight_with("qa", &json!({"episode": "ep02"}), &d, &s, &no_probe).unwrap_err();
    assert!(e.contains("找不到 ffprobe") && e.contains("winget install Gyan.FFmpeg"), "{e}");
    // missing video (path with Chinese + spaces)
    let e = preflight_with("qa", &json!({"episode": "ep02"}), &d, &s, &all).unwrap_err();
    assert!(e.contains("找不到影片檔：EP02_Final.mp4") && e.contains("預檢"), "{e}");
    std::fs::write(d.join("EP02_Final.mp4"), b"x").unwrap();
    assert!(preflight_with("qa", &json!({"episode": "ep02"}), &d, &s, &all).is_ok());
    // unknown episode / missing src_cn
    assert!(preflight_with("render", &json!({"episode": "ep09"}), &d, &s, &all).unwrap_err().contains("沒有 ep09"));
    assert!(preflight_with("render", &json!({"episode": "ep02", "src": "src_cn"}), &d, &s, &all).unwrap_err().contains("src_cn"));
    assert!(preflight_with("custom", &json!({"command": "echo"}), &d, &s, &no_probe).is_ok());
    let _ = std::fs::remove_dir_all(&d);
}

/// Expected argv of a `py` step on this platform (`py -3.11 …` on Windows, `python3.11 …` elsewhere).
fn pyargs(rest: &[&str]) -> Vec<String> {
    let mut v = crate::platform::python311().1;
    v.extend(rest.iter().map(|s| s.to_string()));
    v
}
