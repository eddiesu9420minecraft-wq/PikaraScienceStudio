// 第 06 幕獨立入口：npx remotion studio src/entries/act06.tsx
// 只 import 這一幕，其他幕的編輯中檔案不會影響這裡的 bundle。
import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {Act06} from '../acts/Act06';
import {StandaloneAct} from '../episode/StandaloneAct';
import {getAct} from '../acts/actData';

const span = getAct('act06');
const Preview: React.FC<{withAudio?: boolean}> = ({withAudio = true}) => <StandaloneAct actId="act06" Comp={Act06} withAudio={withAudio} />;

registerRoot(() => (
  <Composition id="EP01-Act06" component={Preview} durationInFrames={Math.max(1, span.durationFrames)} fps={60} width={1920} height={1080} defaultProps={{withAudio: true}} />
));
