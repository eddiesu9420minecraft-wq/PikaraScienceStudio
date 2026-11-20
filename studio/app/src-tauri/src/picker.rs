//! Native Windows "Open file" dialog (GetOpenFileNameW) for importing material — no plugin, no extra permissions:
//! the web UI only receives the paths the user picked.

#[cfg(windows)]
pub fn pick_files(title: &str, multi: bool) -> Result<Vec<String>, String> {
    use windows_sys::Win32::UI::Controls::Dialogs::{GetOpenFileNameW, OFN_ALLOWMULTISELECT, OFN_EXPLORER, OFN_FILEMUSTEXIST, OFN_NOCHANGEDIR, OFN_PATHMUSTEXIST, OPENFILENAMEW};
    let wide = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
    // filter pairs, each NUL-terminated, list double-NUL-terminated
    let mut filter: Vec<u16> = vec![];
    for (name, pat) in [
        ("支援的素材", "*.txt;*.md;*.markdown;*.pdf;*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp;*.mp4;*.mov;*.mkv;*.webm;*.avi;*.m4v;*.wav;*.mp3;*.flac;*.m4a;*.ogg;*.aac;*.docx;*.html;*.htm;*.json;*.csv"),
        ("所有檔案", "*.*"),
    ] {
        filter.extend(wide(name));
        filter.push(0);
        filter.extend(wide(pat));
        filter.push(0);
    }
    filter.push(0);
    let mut title_w = wide(title);
    title_w.push(0);
    let mut buf = vec![0u16; 64 * 1024];
    let mut ofn: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    ofn.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
    ofn.lpstrFilter = filter.as_ptr();
    ofn.lpstrFile = buf.as_mut_ptr();
    ofn.nMaxFile = buf.len() as u32;
    ofn.lpstrTitle = title_w.as_ptr();
    ofn.Flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | if multi { OFN_ALLOWMULTISELECT } else { 0 };
    let ok = unsafe { GetOpenFileNameW(&mut ofn) };
    if ok == 0 {
        return Ok(vec![]); // canceled
    }
    // single: "C:\dir\file"; multi: "C:\dir\0file1\0file2\0\0"
    let parts: Vec<String> = buf.split(|c| *c == 0).take_while(|s| !s.is_empty()).map(String::from_utf16_lossy).collect();
    Ok(match parts.len() {
        0 => vec![],
        1 => parts,
        _ => parts[1..].iter().map(|f| std::path::Path::new(&parts[0]).join(f).to_string_lossy().to_string()).collect(),
    })
}

#[cfg(not(windows))]
pub fn pick_files(_title: &str, _multi: bool) -> Result<Vec<String>, String> {
    Err("檔案選擇視窗只支援 Windows".into())
}
