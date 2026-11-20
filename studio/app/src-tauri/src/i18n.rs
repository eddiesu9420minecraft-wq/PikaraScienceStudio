//! Simplified-Chinese labels for job kinds and doctor checks (UI 繁/简 toggle).
//! Keys are the stable ids (`kind` / check `id`); details stay in Traditional Chinese.

pub fn cn_label(key: &str) -> Option<&'static str> {
    Some(match key {
        // job kinds
        "voiceover_tw" => "配音 zh-TW（CosyVoice）",
        "voiceover_cn" => "配音 zh-CN（CosyVoice）",
        "timeline" => "时间轴＋字幕",
        "mix" => "混音",
        "render" => "渲染（render.mjs）",
        "qa" => "质量检查（qa_video.py）",
        "make_cn" => "生成 zh-CN 源代码（make_cn.py；保留简体已有旁白与时间轴）",
        "final_tw" => "繁中正式版（时间轴→字幕→混音→渲染 30fps→QA）",
        "youtube_15x" => "YouTube 1.5× 版（SRT 缩放＋<EP>-YT15）",
        "bilibili" => "Bilibili zh-CN 全流程",
        "custom" => "自定义命令（cmd /c）",
        "claude" => "Claude 无头运行",
        "doctor_fix" => "环境修复",
        // doctor checks
        "os.version" => "Windows 版本",
        "os.longpaths" => "长路径支持",
        "webview2" => "WebView2 Runtime",
        "gpu.driver" => "NVIDIA GPU 与驱动",
        "node" => "Node.js / npm",
        "npm.deps" => "项目 node_modules（Remotion）",
        "browser.chs" => "Remotion chrome-headless-shell",
        "ffmpeg.present" => "ffmpeg",
        "ffmpeg.nvenc" => "ffmpeg NVENC",
        "py311" => "Python 3.11",
        "cosy.venv" => "CosyVoice venv",
        "cosy.model" => "CosyVoice3 模型",
        "whisper.model" => "Whisper large-v3-turbo",
        "disk.free" => "磁盘空间",
        "git" => "Git",
        "check:claude" => "Claude Code CLI（可选）",
        "project.folders" => "项目输出文件夹",
        _ => return None,
    })
}
