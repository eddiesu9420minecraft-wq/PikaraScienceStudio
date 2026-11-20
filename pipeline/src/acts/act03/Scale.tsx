import React from 'react';
import {palette as P} from '../../theme/palette';
import {ease, lerp, progress} from '../../lib/anim';
import {A3, MONO, SANS} from './common';
import {TILE70} from './Stack';

/**
 * 段落 5–6：參數規模比較。面積 ∝ 參數量（4 : 8 : 70），同樣密度的小方格。
 * 「參數越多」：方塊壓彎底座；「記憶體」：下方記憶體／計算量條同比例上升。
 * 之後 70B 方塊推近、變成訓練段落的權重矩陣。
 */
const BASE = 600;
const sideK = (b: number) => Math.sqrt(b / 70);
const MODELS = [
  {b: 4, x: 560, label: '4B', sub: '約 40 億'},
  {b: 8, x: 850, label: '8B', sub: '約 80 億'},
  {b: 70, x: TILE70.x, label: '70B', sub: '約 700 億'},
];
export const TRAIN_RECT = {x: 672, y: 162, w: 576, h: 576};

export const Scale: React.FC<{frame: number; A: A3}> = ({frame: f, A}) => {
  if (f < A.sizes + 10 || f > A.train + 10) return null;
  const leave = progress(f, A.l7 - 20, A.l7 + 30); // 其他元素退場
  const morph = ease.camera(progress(f, A.l7 - 10, A.train - 20)); // 70B → 訓練矩陣
  const fadeAll = 1 - progress(f, A.train - 40, A.train - 5);
  const sagT = ease.out(progress(f, A.bigger - 10, A.bigger + 40));
  const memT = (b: number) => ease.out(progress(f, A.memory - 40 + (b === 70 ? 14 : b === 8 ? 7 : 0), A.memory + 30 + (b === 70 ? 30 : 0)));
  const eqT = ease.out(progress(f, A.billion - 40, A.billion + 4));

  const labelT = (q: number) => ease.out(progress(f, A.sizes + 30 + q * 26, A.sizes + 56 + q * 26));
  const subT = (q: number) =>
    q === 0 ? ease.out(progress(f, A.b4 - 18, A.b4 + 12)) : q === 1 ? ease.out(progress(f, (A.b4 + A.b70) / 2 - 18, (A.b4 + A.b70) / 2 + 12)) : ease.out(progress(f, A.b70 - 18, A.b70 + 12));
  const focus = (q: number) => {
    // 唸到該數字時微亮
    const c = q === 0 ? A.b4 : q === 1 ? (A.b4 + A.b70) / 2 : A.b70;
    return Math.max(0, 1 - Math.abs(f - c - 10) / 50);
  };

  return (
    <div style={{position: 'absolute', inset: 0, opacity: fadeAll}}>
      <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
        <defs>
          <pattern id="a3params" width={9} height={9} patternUnits="userSpaceOnUse">
            <rect x={1.5} y={1.5} width={6} height={6} rx={1} fill={P.amber} />
          </pattern>
          <pattern id="a3params2" width={27} height={45} patternUnits="userSpaceOnUse">
            <rect x={10.5} y={10.5} width={6} height={6} rx={1} fill={P.ice} />
            <rect x={19.5} y={28.5} width={6} height={6} rx={1} fill={P.ice} />
            <rect x={1.5} y={37.5} width={6} height={6} rx={1} fill={P.ice} />
          </pattern>
        </defs>

        <g opacity={1 - leave}>
          {/* 底座（被壓彎） */}
          <path
            d={`M 470 ${BASE} L ${TILE70.x - 30} ${BASE} Q ${TILE70.x + TILE70.w / 2} ${BASE + 2 * 14 * sagT} ${TILE70.x + TILE70.w + 30} ${BASE} L 1790 ${BASE}`}
            fill="none"
            stroke={P.metalLight}
            strokeWidth={3}
            strokeLinecap="round"
            opacity={progress(f, A.sizes + 20, A.sizes + 50)}
          />
          {/* 公式 B = billion = 十億 */}
          {eqT > 0 ? (
            <text x={170} y={300} fontFamily={SANS} fontSize={64} fontWeight={800} fill={P.paper} opacity={eqT} transform={`translate(0 ${(1 - eqT) * 16})`}>
              <tspan fill={P.amber}>B</tspan>
              <tspan dx={20} fill={P.mist} fontWeight={500}>
                =
              </tspan>
              <tspan dx={20} fontFamily={MONO} fontWeight={600} fontSize={56}>
                billion
              </tspan>
              <tspan dx={20} fill={P.mist} fontWeight={500}>
                =
              </tspan>
              <tspan dx={20}>十億</tspan>
            </text>
          ) : null}
          {eqT > 0 ? (
            <text x={170} y={360} fontFamily={MONO} fontSize={28} fill={P.mist} opacity={eqT * 0.9}>
              1B = 1,000,000,000
            </text>
          ) : null}
          <text x={TILE70.x + TILE70.w} y={TILE70.y - 26} fontFamily={SANS} fontSize={22} fill={P.mist} textAnchor="end" letterSpacing="0.06em" opacity={progress(f, A.sizes + 80, A.sizes + 110)}>
            面積 ∝ 參數數量（示意圖）
          </text>
        </g>

        {MODELS.map((m, q) => {
          const k = sideK(m.b);
          const w = TILE70.w * k;
          const h = TILE70.h * k;
          const sag = (m.b === 70 ? 14 : m.b === 8 ? 3 : 1.5) * sagT;
          let x = m.x;
          let y = BASE - h + sag;
          let ww = w;
          let hh = h;
          const grow = m.b === 70 ? 1 : ease.out(progress(f, A.sizes + 24 + q * 22, A.sizes + 70 + q * 22));
          let op = 1;
          if (m.b === 70) {
            x = lerp(x, TRAIN_RECT.x, morph);
            y = lerp(y, TRAIN_RECT.y, morph);
            ww = lerp(w, TRAIN_RECT.w, morph);
            hh = lerp(h, TRAIN_RECT.h, morph);
            op = progress(f, A.sizes + 12, A.sizes + 44);
          } else op = 1 - leave;
          if (grow <= 0 || op <= 0) return null;
          const gw = ww * grow;
          const gh = hh * grow;
          const fc = focus(q);
          const lt = labelT(q) * (1 - leave);
          const st = subT(q) * (1 - leave);
          const cxm = m.x + w / 2;
          return (
            <g key={m.b} opacity={op}>
              {/* 陰影＝重量 */}
              <ellipse cx={x + ww / 2} cy={BASE + sag + 6} rx={ww * 0.55} ry={6 + 6 * k} fill="#000" opacity={0.35 * (1 - morph) * grow} />
              <rect x={x} y={y + hh - gh} width={gw} height={gh} rx={6} fill="#141C30" stroke={P.amber} strokeOpacity={0.55 + 0.4 * fc} strokeWidth={2} />
              <rect x={x + 3} y={y + hh - gh + 3} width={Math.max(0, gw - 6)} height={Math.max(0, gh - 6)} fill="url(#a3params)" opacity={0.7 + 0.3 * fc} />
              <rect x={x + 3} y={y + hh - gh + 3} width={Math.max(0, gw - 6)} height={Math.max(0, gh - 6)} fill="url(#a3params2)" opacity={0.95} />
              {lt > 0 ? (
                <text x={cxm} y={668} fontFamily={SANS} fontSize={m.b === 70 ? 54 : 46} fontWeight={800} fill={P.amber} textAnchor="middle" opacity={lt} transform={`translate(0 ${(1 - lt) * 12})`}>
                  {m.label}
                </text>
              ) : null}
              {st > 0 ? (
                <text x={cxm} y={714} fontFamily={SANS} fontSize={28} fontWeight={600} fill={P.paper} textAnchor="middle" opacity={st}>
                  {m.sub}
                </text>
              ) : null}
              {/* 記憶體／計算量條 */}
              {[0, 1].map((row) => {
                const t = memT(m.b) * (1 - leave);
                if (t <= 0) return null;
                const L = TILE70.w * (m.b / 70) * t;
                const yy = 768 + row * 42;
                return (
                  <g key={row}>
                    <rect x={m.x} y={yy - 8} width={TILE70.w * (m.b / 70)} height={16} rx={8} fill={P.line} opacity={0.5 * t} />
                    <rect x={m.x} y={yy - 8} width={Math.max(16, L)} height={16} rx={8} fill={row === 0 ? P.amber : P.ice} opacity={0.9} />
                  </g>
                );
              })}
            </g>
          );
        })}
        {/* 條的標籤 */}
        {memT(4) > 0 && leave < 1
          ? ['記憶體', '計算量'].map((s, row) => (
              <text key={s} x={530} y={768 + row * 42} fontFamily={SANS} fontSize={24} fontWeight={600} fill={row === 0 ? P.amber : P.ice} textAnchor="end" dominantBaseline="central" opacity={memT(4) * (1 - leave)}>
                {s}
              </text>
            ))
          : null}
      </svg>
    </div>
  );
};
