import React from 'react';

// 柔和暗角：統一畫面收邊（低強度，避免「濾鏡感」）
export const Vignette: React.FC<{strength?: number}> = ({strength = 0.55}) => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      background: `radial-gradient(ellipse 75% 70% at 50% 50%, rgba(0,0,0,0) 60%, rgba(4,6,12,${strength}) 100%)`,
    }}
  />
);
