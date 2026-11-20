import React from 'react';
import {palette as P} from '../theme/palette';
import {fontStack} from '../theme/fonts';
import {progress} from '../lib/anim';

export type Cue = {from: number; to: number; text: string};

/**
 * 字幕：55px（比第一階段放大 25%），位於底部安全區。
 * 背後有一條很淡的底部漸層帶，讓字幕在明亮畫面（例如 PCB 特寫）上仍清楚；
 * 漸層帶只在附近有字幕時出現，句與句之間不會閃爍（以 18 幀窗口平滑）。
 */
export const Subtitles: React.FC<{frame: number; cues: Cue[]}> = ({frame, cues}) => {
  const cue = cues.find((c) => frame >= c.from && frame < c.to);
  // 漸層帶：距離最近字幕的距離決定強度
  let near = 0;
  for (const c of cues) {
    if (c.to < frame - 24 || c.from > frame + 24) continue;
    const d = frame < c.from ? c.from - frame : frame > c.to ? frame - c.to : 0;
    near = Math.max(near, 1 - Math.min(1, d / 24));
  }
  const o = cue ? progress(frame, cue.from, cue.from + 8) * (1 - progress(frame, cue.to - 8, cue.to)) : 0;
  return (
    <>
      {near > 0 ? (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: 250,
            opacity: near,
            background: 'linear-gradient(180deg, rgba(5,8,16,0) 0%, rgba(5,8,16,0.38) 55%, rgba(5,8,16,0.6) 100%)',
            pointerEvents: 'none',
          }}
        />
      ) : null}
      {cue ? (
        <div style={{position: 'absolute', left: 192, right: 192, bottom: 64, textAlign: 'center', opacity: o}}>
          <span
            style={{
              fontFamily: fontStack,
              fontWeight: 600,
              fontSize: 55,
              lineHeight: 1.45,
              color: P.paper,
              letterSpacing: '0.04em',
              textShadow: '0 2px 0 rgba(5,8,16,0.9), 0 0 18px rgba(5,8,16,0.8)',
            }}
          >
            {cue.text}
          </span>
        </div>
      ) : null}
    </>
  );
};
