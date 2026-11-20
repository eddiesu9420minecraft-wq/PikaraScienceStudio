import React, {useMemo} from 'react';
import {AbsoluteFill} from 'remotion';

/**
 * 讀取 Chromium 實際使用的 WebGL 後端（ANGLE / SwiftShader）與顯示卡型號。
 * scripts/gpu-check.mjs 會渲染這一幀並從瀏覽器 console 擷取 [gpu-probe] 輸出。
 */
export const readWebGlInfo = () => {
  const canvas = document.createElement('canvas');
  const gl = (canvas.getContext('webgl2', {powerPreference: 'high-performance'}) ||
    canvas.getContext('webgl', {powerPreference: 'high-performance'})) as WebGLRenderingContext | null;
  if (!gl) return {ok: false, renderer: 'NO_WEBGL', vendor: '', version: ''};
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  const vendor = ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR));
  return {ok: true, renderer, vendor, version: String(gl.getParameter(gl.VERSION))};
};

export const GpuProbe: React.FC = () => {
  const info = useMemo(() => {
    const i = readWebGlInfo();
    console.log('[gpu-probe]' + JSON.stringify(i));
    return i;
  }, []);
  return (
    <AbsoluteFill style={{background: '#0F1626', color: '#EEF1F7', fontSize: 28, padding: 60, fontFamily: 'monospace'}}>
      <div>renderer: {info.renderer}</div>
      <div>vendor: {info.vendor}</div>
      <div>version: {info.version}</div>
    </AbsoluteFill>
  );
};
