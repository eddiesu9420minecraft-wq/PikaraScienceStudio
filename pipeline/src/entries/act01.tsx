// 第 01 幕獨立入口：npx remotion studio src/entries/act01.tsx
// 只 import 這一幕，其他幕的編輯中檔案不會影響這裡的 bundle。
import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {Act01} from '../acts/Act01';
import {StandaloneAct} from '../episode/StandaloneAct';
import {getAct} from '../acts/actData';

const span = getAct('act01');
const Preview: React.FC<{withAudio?: boolean}> = ({withAudio = true}) => <StandaloneAct actId="act01" Comp={Act01} withAudio={withAudio} />;

registerRoot(() => (
  <Composition id="EP01-Act01" component={Preview} durationInFrames={Math.max(1, span.durationFrames)} fps={60} width={1920} height={1080} defaultProps={{withAudio: true}} />
));
