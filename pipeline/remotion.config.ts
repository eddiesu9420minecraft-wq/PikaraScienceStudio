import {Config} from '@remotion/cli/config';

// 共用設定；GPU / CPU 模式的差異由 scripts/render.mjs 透過 CLI 參數傳入。
Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(95);
Config.setOverwriteOutput(true);
// Windows 上 ANGLE 走 Direct3D 11，是 Chrome 的硬體加速 WebGL 路徑
Config.setChromiumOpenGlRenderer('angle');
