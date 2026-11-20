// 第一階段測試片獨立入口（只 import ArtTest 與其場景）：
//   node scripts/stills.mjs 60,300,700 ArtTest src/entries/arttest.tsx
import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {ArtTest} from '../scenes/test/ArtTest';
import {getTimeline} from '../data/timeline';

const tl = getTimeline('arttest');

registerRoot(() => (
  <Composition
    id="ArtTest"
    component={ArtTest}
    durationInFrames={tl?.totalFrames ?? 900}
    fps={60}
    width={1920}
    height={1080}
    defaultProps={{frameOffset: 0, showSubtitles: true, withAudio: false}}
  />
));
