// 影片封面：node scripts/stills.mjs 0 EP01-Thumbnail src/entries/thumbnail.tsx
// 設計依 B 站優質科技科普封面慣例：一個強主體、2–3 行超大粗字（深色描邊保證縮圖可讀）、
// 一個高對比色塊強調關鍵字、少量標籤；縮到 320px 寬仍能讀出主標。
import React from 'react';
import {AbsoluteFill, Composition, registerRoot} from 'remotion';
import {GpuWorld} from '../scenes/test/GpuWorld';
import {PikaraMark} from '../components/PikaraBrand';
import {palette as P} from '../theme/palette';
import {ensureFonts, fontStack} from '../theme/fonts';

ensureFonts();

const stroke = (w: number, c = '#05070D') => ({
  WebkitTextStroke: `${w}px ${c}`,
  paintOrder: 'stroke fill' as const,
  textShadow: `0 ${w * 0.6}px ${w * 2.2}px rgba(0,0,0,0.65)`,
});

const Thumbnail: React.FC<{tplFrame?: number}> = ({tplFrame = 676}) => (
  <AbsoluteFill style={{background: P.ink, fontFamily: fontStack, overflow: 'hidden'}}>
    {/* 主體：晶片上的矩陣運算（實際 3D 渲染），放大偏右 */}
    <div style={{position: 'absolute', left: 330, top: -60, width: 1920, height: 1080, transform: 'scale(1.25) rotate(-4deg)', transformOrigin: '62% 55%'}}>
      <GpuWorld frame={tplFrame} width={1920} height={1080} />
    </div>
    {/* 色調統一：暗角 + 左側壓暗 + 微暖光 */}
    <div style={{position: 'absolute', inset: 0, background: 'radial-gradient(ellipse 60% 70% at 68% 52%, rgba(255,181,71,0.18) 0%, rgba(255,181,71,0) 60%)', mixBlendMode: 'screen'}} />
    <div style={{position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(6,9,18,0.96) 0%, rgba(6,9,18,0.86) 36%, rgba(6,9,18,0.2) 64%, rgba(6,9,18,0) 78%)'}} />
    <div style={{position: 'absolute', inset: 0, boxShadow: 'inset 0 0 220px 40px rgba(0,0,0,0.75)'}} />

    {/* 主標 */}
    <div style={{position: 'absolute', left: 92, top: 128, width: 1150}}>
      <div style={{fontSize: 168, fontWeight: 900, color: '#FFFFFF', lineHeight: 1.04, letterSpacing: '-0.01em', ...stroke(10)}}>AI 在你電腦裡</div>
      <div style={{fontSize: 180, fontWeight: 900, color: P.amber, lineHeight: 1.06, letterSpacing: "-0.02em", marginTop: 6, whiteSpace: "nowrap", ...stroke(12)}}>到底怎麼跑？</div>
      {/* 黃底黑字強調條 */}
      <div style={{display: 'inline-flex', alignItems: 'center', gap: 18, marginTop: 34, background: '#FFD43B', padding: '14px 30px 16px', transform: 'rotate(-1.5deg)', boxShadow: '0 10px 30px rgba(0,0,0,0.55)'}}>
        <span style={{fontSize: 70, fontWeight: 900, color: '#0B0E16', letterSpacing: '0.01em'}}>llama.cpp 一次看懂</span>
      </div>
      <div style={{display: 'flex', gap: 16, marginTop: 40}}>
        {['權重', '量化', 'GGUF', 'VRAM', 'Token'].map((t) => (
          <div key={t} style={{fontSize: 40, fontWeight: 800, color: P.paper, padding: '6px 20px 8px', border: `3px solid ${P.ice}`, background: 'rgba(9,13,24,0.7)'}}>
            {t}
          </div>
        ))}
      </div>
    </div>

    {/* 集數與品牌 */}
    <div style={{position: 'absolute', right: 64, bottom: 54, display: 'flex', alignItems: 'center', gap: 6}}>
      <div style={{width: 96, height: 96, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
        <div style={{transform: 'scale(0.4)'}}>
          <PikaraMark t={1} />
        </div>
      </div>
      <div style={{fontSize: 32, color: P.paper, letterSpacing: '0.24em', fontWeight: 800, ...stroke(4)}}>PIKARA SCIENCE</div>
    </div>
    <div style={{position: 'absolute', right: 64, top: 52, fontSize: 64, fontWeight: 900, color: '#0B0E16', background: P.amber, padding: '4px 22px 8px', letterSpacing: '0.06em'}}>EP01</div>
  </AbsoluteFill>
);

registerRoot(() => <Composition id="EP01-Thumbnail" component={Thumbnail} durationInFrames={1} fps={60} width={1920} height={1080} defaultProps={{tplFrame: 676}} />);
