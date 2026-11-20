import React from 'react';
import {clamp, ease, lerp, progress} from '../../lib/anim';
import {A, an, HatchDefs, MONO, P, Txt, fontStack} from './common';

/**
 * 站點 6：理論權重大小 = 參數量 × 位元數 ÷ 8（1 GB = 10⁹ 位元組）。
 *   8B：FP32 32、FP16 16、INT8 8、4 位元 4 GB；70B × 4 位元 = 35 GB。
 * 參考線：6 GB、8 GB VRAM。最後把 4 位元長條放大，加上「額外資料」（示意，未按比例）。
 */
export const CH = {yB: 760, yT: 290, x0: 250, x1: 1700};
const BARS = [
  {key: 'c32', label: 'FP32', gb: 32, x: 380},
  {key: 'c16', label: 'FP16', gb: 16, x: 590},
  {key: 'c8', label: 'INT8', gb: 8, x: 800},
  {key: 'c4', label: '4 位元', gb: 4, x: 1010},
];
export const BAR4 = {x: 1010, w: 150, extraGb: 0.9};
const BW = 150;
const B70X = 1380;

/** 隨時間變化的座標軸上限（GB）。 */
export const axisMax = (f: number, anchors: A) => {
  const b70 = an(anchors, 'b70', 5874);
  const actual = an(anchors, 'actual', 6129);
  const m1 = lerp(34, 40, ease.inOut(progress(f, b70 - 40, b70 + 20)));
  return lerp(m1, 9, ease.camera(progress(f, actual - 10, actual + 60)));
};
export const gbToY = (gb: number, max: number) => CH.yB - (gb / max) * (CH.yB - CH.yT);

export const SizeChart: React.FC<{f: number; anchors: A}> = ({f, anchors}) => {
  const formula = an(anchors, 'formula', 4730);
  const c32 = an(anchors, 'c32', 5263);
  const b70 = an(anchors, 'b70', 5874);
  const exceed = an(anchors, 'exceed', 5921);
  const actual = an(anchors, 'actual', 6129);
  const gguf = an(anchors, 'gguf', 6855);

  const max = axisMax(f, anchors);
  const y = (gb: number) => gbToY(gb, max);
  const tF = progress(f, formula - 40, formula + 10);
  const tAxis = progress(f, c32 - 100, c32 - 50);
  const tRef = progress(f, c32 - 90, c32 - 40);
  const dimOthers = 1 - 0.55 * ease.inOut(progress(f, b70 - 30, b70 + 10));
  const hideOthers = 1 - progress(f, actual - 50, actual - 15);
  const t70 = ease.out(progress(f, b70 - 16, b70 + 30));
  const tEx = ease.out(progress(f, exceed - 6, exceed + 30));
  const tExtra = ease.out(progress(f, actual + 40, actual + 90));
  const tExtraLabel = progress(f, actual + 70, actual + 110);
  const barHide = progress(f, gguf - 112, gguf - 108); // 長條交給下一站變形
  const out = 1 - progress(f, gguf - 100, gguf - 60);

  const big = clamp((max - 12) / 10);
  const ticksBig = [0, 10, 20, 30, 40];
  const ticksSmall = [2, 4, 6, 8];

  return (
    <div style={{position: 'absolute', inset: 0}}>
      <div style={{opacity: out}}>
        <div
          style={{
            position: 'absolute',
            left: 0,
            width: 1920,
            top: 84,
            textAlign: 'center',
            fontFamily: fontStack,
            fontSize: 50,
            fontWeight: 800,
            color: P.paper,
            opacity: tF,
            transform: `translateY(${(1 - ease.out(tF)) * 20}px)`,
            letterSpacing: '0.06em',
          }}
        >
          參數量 <span style={{color: P.mist}}>×</span> <span style={{color: P.amber}}>位元數</span> <span style={{color: P.mist}}>÷ 8 ＝</span> 位元組
        </div>
        <Txt x={960} y={186} align="center" size={22} color={P.mist} t={progress(f, formula + 10, formula + 50)}>
          理論值＝參數量×位元數÷8（不含額外資料）· 1 GB ＝ 10⁹ 位元組
        </Txt>
      </div>

      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
        <defs>
          <HatchDefs id="a4chartHatch" color={P.amber} gap={10} width={2} />
          <clipPath id="a4chartClip">
            <rect x={0} y={CH.yT - 70} width={1920} height={CH.yB - CH.yT + 70} />
          </clipPath>
        </defs>
        <g opacity={out}>
          {/* 座標軸 */}
          <line x1={CH.x0} x2={lerp(CH.x0, CH.x1, ease.out(tAxis))} y1={CH.yB} y2={CH.yB} stroke={P.mist} strokeWidth={1.5} />
          {ticksBig.map((g) => {
            const yy = y(g);
            if (yy < CH.yT - 40) return null;
            return (
              <g key={`b${g}`} opacity={tAxis * big}>
                <line x1={CH.x0} x2={CH.x1} y1={yy} y2={yy} stroke={P.line} strokeWidth={1} opacity={g === 0 ? 0 : 0.8} />
                <text x={CH.x0 - 16} y={yy + 7} textAnchor="end" fontFamily={MONO} fontSize={20} fill={P.mist}>
                  {g}
                </text>
              </g>
            );
          })}
          {ticksSmall.map((g) => {
            const yy = y(g);
            return (
              <g key={`s${g}`} opacity={tAxis * (1 - big)}>
                <line x1={CH.x0} x2={CH.x1} y1={yy} y2={yy} stroke={P.line} strokeWidth={1} opacity={0.8} />
                <text x={CH.x0 - 16} y={yy + 7} textAnchor="end" fontFamily={MONO} fontSize={20} fill={P.mist}>
                  {g}
                </text>
              </g>
            );
          })}
          <text x={CH.x0 - 16} y={CH.yT - 36} textAnchor="end" fontFamily={fontStack} fontSize={20} fill={P.mist} opacity={tAxis}>
            GB
          </text>

          {/* 長條 */}
          <g clipPath="url(#a4chartClip)">
            {BARS.map((b) => {
              const a = an(anchors, b.key, 5300);
              const g = ease.out(progress(f, a - 14, a + 26));
              if (g <= 0) return null;
              const is4 = b.gb === 4;
              const o = is4 ? lerp(dimOthers, 1, progress(f, actual - 50, actual - 10)) : dimOthers * hideOthers;
              const top = y(b.gb * g);
              const extraTop = y(b.gb + BAR4.extraGb * tExtra);
              return (
                <g key={b.key} opacity={o * (is4 ? 1 - barHide : 1)}>
                  {is4 && tExtra > 0 ? (
                    <>
                      <rect x={b.x} y={extraTop} width={BW} height={Math.max(0, top - extraTop)} fill="url(#a4chartHatch)" />
                      <rect x={b.x} y={extraTop} width={BW} height={Math.max(0, top - extraTop)} fill="none" stroke={P.amber} strokeWidth={1.6} strokeDasharray="5 4" />
                    </>
                  ) : null}
                  <rect x={b.x} y={top} width={BW} height={CH.yB - top} fill={P.amber} fillOpacity={0.9} />
                  <rect x={b.x} y={top} width={BW} height={4} fill={P.paper} fillOpacity={0.5} />
                </g>
              );
            })}
            {t70 > 0 ? (
              <g opacity={t70 * hideOthers}>
                <rect x={B70X} y={y(35 * t70)} width={BW + 20} height={CH.yB - y(35 * t70)} fill={P.amberDeep} fillOpacity={0.95} />
                <rect x={B70X} y={y(35 * t70)} width={BW + 20} height={4} fill={P.paper} fillOpacity={0.5} />
              </g>
            ) : null}
          </g>

          {/* 數值與名稱 */}
          {BARS.map((b) => {
            const a = an(anchors, b.key, 5300);
            const g = progress(f, a - 4, a + 26);
            if (g <= 0) return null;
            const is4 = b.gb === 4;
            const o = is4 ? 1 : dimOthers * hideOthers;
            return (
              <g key={`l${b.key}`} opacity={o * (1 - barHide)}>
                <text x={b.x + BW / 2} y={y(b.gb) - 18} textAnchor="middle" fontFamily={fontStack} fontSize={30} fontWeight={800} fill={P.paper} stroke={P.ink} strokeWidth={7} paintOrder="stroke" opacity={g * (is4 ? 1 - tExtra : 1)}>
                  ≈ {b.gb} GB
                </text>
                <text x={b.x + BW / 2} y={CH.yB + 38} textAnchor="middle" fontFamily={fontStack} fontSize={24} fontWeight={700} fill={P.paper} opacity={g}>
                  {b.label}
                </text>
              </g>
            );
          })}
          <g opacity={progress(f, c32 - 10, c32 + 20) * hideOthers}>
            <line x1={380} x2={1160} y1={CH.yB + 60} y2={CH.yB + 60} stroke={P.mist} strokeWidth={1} opacity={0.6} />
            <text x={770} y={CH.yB + 92} textAnchor="middle" fontFamily={fontStack} fontSize={22} fill={P.mist}>
              8B 模型
            </text>
          </g>
          {t70 > 0 ? (
            <g opacity={t70 * hideOthers}>
              <text x={B70X + (BW + 20) / 2} y={y(35 * t70) - 18} textAnchor="middle" fontFamily={fontStack} fontSize={34} fontWeight={800} fill={P.amber}>
                ≈ 35 GB
              </text>
              <text x={B70X + (BW + 20) / 2} y={CH.yB + 38} textAnchor="middle" fontFamily={fontStack} fontSize={24} fontWeight={700} fill={P.paper}>
                4 位元
              </text>
              <text x={B70X + (BW + 20) / 2} y={CH.yB + 92} textAnchor="middle" fontFamily={fontStack} fontSize={22} fill={P.mist}>
                70B 模型
              </text>
            </g>
          ) : null}

          {/* 遠遠超過 */}
          {tEx > 0 ? (
            <g opacity={tEx * hideOthers}>
              <line x1={B70X + BW + 46} x2={B70X + BW + 46} y1={y(8)} y2={lerp(y(8), y(35), tEx)} stroke={P.amber} strokeWidth={2} />
              <path d={`M ${B70X + BW + 38} ${y(35) + 12} L ${B70X + BW + 46} ${y(35)} L ${B70X + BW + 54} ${y(35) + 12}`} fill="none" stroke={P.amber} strokeWidth={2} opacity={tEx} />
              <text x={B70X + BW + 62} y={(y(8) + y(35)) / 2 + 10} fontFamily={fontStack} fontSize={28} fontWeight={800} fill={P.amber}>
                遠遠超過
              </text>
            </g>
          ) : null}

          {/* VRAM 參考線 */}
          {[6, 8].map((g) => (
            <g key={g} opacity={tRef}>
              <line x1={CH.x0} x2={CH.x1} y1={y(g)} y2={y(g)} stroke={P.ice} strokeWidth={2} strokeDasharray="10 8" />
              <text x={CH.x1 + 14} y={y(g) + (g === 8 ? -4 : 22)} fontFamily={fontStack} fontSize={22} fontWeight={700} fill={P.ice}>
                {g} GB
              </text>
            </g>
          ))}
          <text x={CH.x1 + 14} y={y(8) - 34} fontFamily={fontStack} fontSize={19} fill={P.ice} opacity={tRef * 0.85}>
            筆電 VRAM
          </text>

          {/* 實際檔案：額外資料 */}
          {tExtraLabel > 0 ? (
            <g opacity={tExtraLabel * (1 - barHide)}>
              <line x1={BAR4.x + BW + 12} x2={BAR4.x + BW + 70} y1={(y(4) + y(4 + BAR4.extraGb)) / 2} y2={y(7.2)} stroke={P.paper} strokeWidth={1.2} />
              <line x1={BAR4.x + BW + 70} x2={BAR4.x + BW + 110} y1={y(7.2)} y2={y(7.2)} stroke={P.paper} strokeWidth={1.2} />
              <text x={BAR4.x + BW + 120} y={y(7.2) - 8} fontFamily={fontStack} fontSize={26} fontWeight={700} fill={P.paper}>
                縮放係數、高精度層等額外資料
              </text>
              <text x={BAR4.x + BW + 120} y={y(7.2) + 26} fontFamily={fontStack} fontSize={20} fill={P.mist}>
                （示意，未按比例）
              </text>
              <line x1={BAR4.x - 12} x2={BAR4.x - 60} y1={y(2)} y2={y(2)} stroke={P.paper} strokeWidth={1.2} />
              <text x={BAR4.x - 70} y={y(2) + 9} textAnchor="end" fontFamily={fontStack} fontSize={26} fontWeight={700} fill={P.paper}>
                理論值 ≈ 4 GB
              </text>
              <text x={BAR4.x + BW / 2} y={y(4 + BAR4.extraGb) - 20} textAnchor="middle" fontFamily={fontStack} fontSize={24} fontWeight={700} fill={P.amber}>
                實際檔案會大一些
              </text>
            </g>
          ) : null}
        </g>
        <BitsToBytes f={f} start={formula + 40} end={c32 - 70} />
      </svg>
    </div>
  );
};

/** 「÷ 8」：16 個位元每 8 個一組 → 2 個位元組。 */
const BitsToBytes: React.FC<{f: number; start: number; end: number}> = ({f, start, end}) => {
  const tIn = ease.out(progress(f, start, start + 40));
  const out = 1 - progress(f, end - 30, end);
  if (tIn <= 0 || out <= 0) return null;
  const span = end - start;
  const split = ease.inOut(progress(f, start + span * 0.25, start + span * 0.25 + 40));
  const sq = ease.inOut(progress(f, start + span * 0.5, start + span * 0.5 + 45));
  const tRes = ease.out(progress(f, start + span * 0.62, start + span * 0.62 + 30));
  const cw = 40;
  const pitch = 46;
  const cx0 = 960;
  const y0 = 470;
  const cells: React.ReactNode[] = [];
  const groups = [0, 1];
  const gCenter = (g: number) => cx0 + (g === 0 ? -1 : 1) * (4 * pitch + 20 * split) - (g === 0 ? 0 : 0);
  for (let i = 0; i < 16; i++) {
    const g = i < 8 ? 0 : 1;
    const j = i % 8;
    const k = ease.out(clamp(tIn * 2 - i * 0.05));
    const off = (j - 3.5) * pitch * (1 - 0.55 * sq);
    const x = gCenter(g) + off - (cw * (1 - 0.55 * sq)) / 2;
    cells.push(<rect key={i} x={x} y={y0 + (1 - k) * 20} width={cw * (1 - 0.55 * sq)} height={64} rx={3} fill={P.amber} opacity={k * lerp(0.9, 0.75, sq)} />);
  }
  return (
    <g opacity={out}>
      <text x={cx0} y={y0 - 40} textAnchor="middle" fontFamily={fontStack} fontSize={28} fontWeight={700} fill={P.paper} opacity={tIn}>
        1 個參數 · FP16 ＝ 16 位元
      </text>
      {cells}
      {groups.map((g) => {
        const w = 8 * pitch * (1 - 0.55 * sq) + 14;
        return (
          <g key={g} opacity={split}>
            <path d={`M ${gCenter(g) - w / 2} ${y0 + 84} l 0 10 L ${gCenter(g) + w / 2} ${y0 + 94} l 0 -10`} fill="none" stroke={P.ice} strokeWidth={1.6} />
            <text x={gCenter(g)} y={y0 + 132} textAnchor="middle" fontFamily={fontStack} fontSize={24} fontWeight={700} fill={P.ice}>
              {sq > 0.5 ? '1 位元組' : '8 位元'}
            </text>
            {sq > 0.02 ? <rect x={gCenter(g) - w / 2} y={y0 - 8} width={w} height={80} rx={6} fill="none" stroke={P.paper} strokeWidth={2} opacity={sq} /> : null}
          </g>
        );
      })}
      <text x={cx0} y={y0 + 200} textAnchor="middle" fontFamily={fontStack} fontSize={34} fontWeight={800} fill={P.amber} opacity={tRes}>
        16 ÷ 8 ＝ 2 位元組
      </text>
    </g>
  );
};
