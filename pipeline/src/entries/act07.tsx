// 第 07 幕獨立入口：npx remotion studio src/entries/act07.tsx
// 只 import 這一幕，其他幕的編輯中檔案不會影響這裡的 bundle。
import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {Act07} from '../acts/Act07';
import {StandaloneAct} from '../episode/StandaloneAct';
import {getAct} from '../acts/actData';

const span = getAct('act07');
const Preview: React.FC<{withAudio?: boolean}> = ({withAudio = true}) => <StandaloneAct actId="act07" Comp={Act07} withAudio={withAudio} />;

registerRoot(() => (
  <Composition id="EP01-Act07" component={Preview} durationInFrames={Math.max(1, span.durationFrames)} fps={60} width={1920} height={1080} defaultProps={{withAudio: true}} />
));
