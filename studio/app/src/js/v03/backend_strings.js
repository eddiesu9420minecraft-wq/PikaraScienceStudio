// Fixed zh-TW strings that come from the Rust backend (stage titles, statuses, plan items). Listed here only so
// i18n/gen_cn.py puts them in the zh-CN table; the UI passes them through t(). Messages with numbers or paths stay
// in zh-TW when the UI language is zh-CN.
export const BACKEND_STRINGS = [
  '主題與研究', '腳本', '分鏡', '配音', '字幕與時間軸', '動畫', '音訊混合', '渲染輸出', 'QA 報告',
  '尚未產生', '尚未建立', '與輸入一致', '與輸入一致（舊專案基準）', '輸入已變更，需要更新',
  '舊專案：輸出比輸入新，已建立基準', '舊專案：輸入檔比輸出新，可能需要更新', '通用樣板',
  '畫面渲染', '影片編碼', '品質檢查', '研究資料與腳本', '不重新研究、不重寫腳本', '已渲染畫面',
  '依目前時間軸與配音重新混音', '切換前檢查新影片', '全部畫面沿用', '重新建立（內容不變）', '配音或腳本改變，時間軸會更新',
  '新影片（取代目前的成品）', '舊影片保留在這裡（硬連結，不佔額外空間）', '混音（覆寫，可重建）',
  '沒有渲染報告，使用保守預設值', '重新配音前的版本', '重新配音', '重新渲染前的版本', '還原其他版本前的版本',
  '新場景', '內容或旁白改變', '位移不是整數幀', '未改變',
];
