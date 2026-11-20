import React from 'react';
import {clamp, ease, lerp, progress, rng, wobble} from '../../lib/anim';
import {A, an, MONO, P, fontStack} from './common';

/**
 * 站點 7：GGUF 檔案解剖（依 ggml docs/gguf.md）：
 *   Header（magic 47 47 55 46 = "GGUF"、version、tensor_count、metadata_kv_count）
 *   → Metadata key-value → Tensor info（name、shape、type、offset）→ 對齊填充（預設 32 位元組）→ Tensor data
 * 區段比例為示意（實際上張量資料佔絕大部分）。
 */
export const SLAB = {x0: 210, x1: 1710, y: 470, h: 120, dx: 62, dy: -48};
const L = SLAB.x1 - SLAB.x0;
const FR = [0.05, 0.13, 0.12, 0.025, 0.675];
const SECS = [
  {id: 'header', name: '檔頭', color: P.mint},
  {id: 'meta', name: '中繼資料', color: P.ice},
  {id: 'info', name: '張量資訊', color: P.iceDeep},
  {id: 'pad', name: '對齊', color: P.mist},
  {id: 'data', name: '張量資料', color: P.amber},
];
const secX = (() => {
  const xs: number[] = [SLAB.x0];
  let x = SLAB.x0;
  for (const fr of FR) {
    x += fr * L;
    xs.push(x);
  }
  return xs;
})();

/** 從前一站（尺寸圖）4 位元長條在本站座標中的位置。 */
export type FromRect = {x: number; y: number; w: number; h: number};

const Leader: React.FC<{x1: number; y1: number; x2: number; y2: number; t: number; color: string}> = ({x1, y1, x2, y2, t, color}) => {
  if (t <= 0.001) return null;
  const k = ease.out(clamp(t * 1.5));
  return (
    <g opacity={clamp(t * 2)}>
      <circle cx={x1} cy={y1} r={4} fill="none" stroke={color} strokeWidth={1.5} />
      <circle cx={x1} cy={y1} r={1.6} fill={color} />
      <line x1={x1} y1={y1} x2={lerp(x1, x2, k)} y2={lerp(y1, y2, k)} stroke={color} strokeWidth={1.2} opacity={0.8} />
    </g>
  );
};

const Block: React.FC<{x: number; y: number; t: number; children: React.ReactNode; w?: number}> = ({x, y, t, children, w = 520}) => {
  if (t <= 0.001) return null;
  const k = ease.out(clamp(t));
  return (
    <div style={{position: 'absolute', left: x, top: y, width: w, opacity: k, transform: `translateY(${(1 - k) * 16}px)`, fontFamily: fontStack}}>
      {children}
    </div>
  );
};

const KV: React.FC<{k: string; v: string; t: number; vColor?: string}> = ({k, v, t, vColor = P.paper}) => (
  <div style={{fontFamily: MONO, fontSize: 21, lineHeight: '34px', opacity: clamp(t), whiteSpace: 'nowrap', transform: `translateX(${(1 - ease.out(clamp(t))) * -12}px)`}}>
    <span style={{color: P.ice}}>{k}</span>
    <span style={{color: P.mist}}> = </span>
    <span style={{color: vColor}}>{v}</span>
  </div>
);

export const GgufFile: React.FC<{f: number; anchors: A; from: FromRect}> = ({f, anchors, from}) => {
  const gguf = an(anchors, 'gguf', 6855);
  const header = an(anchors, 'header', 7098);
  const meta = an(anchors, 'meta', 7305);
  const tensors = an(anchors, 'tensors', 7431);
  const onefile = an(anchors, 'onefile', 7580);
  const container = an(anchors, 'container', 7984);

  // 長條 → 檔案板
  const morph = ease.camera(progress(f, gguf - 110, gguf - 20));
  const tSec = ease.out(progress(f, gguf - 30, gguf + 30));
  const t3d = ease.out(progress(f, gguf - 40, gguf + 10));
  const fx = lerp(from.x, SLAB.x0, morph);
  const fy = lerp(from.y, SLAB.y, morph);
  const fw = lerp(from.w, L, morph);
  const fh = lerp(from.h, SLAB.h, morph);

  const tHead = progress(f, header - 24, header + 10);
  const tMeta = progress(f, meta - 20, meta + 10);
  const tInfo = progress(f, tensors - 16, tensors + 10);
  const tData = progress(f, tensors + 20, tensors + 50);
  const tOne = ease.out(progress(f, onefile - 10, onefile + 40));
  const tCont = ease.inOut(progress(f, container - 40, container + 10));
  const calloutO = 1 - 0.55 * tOne * (1 - tCont) - tCont;

  // 每個區段被講到時微微浮起
  const lift = (i: number) => {
    const act = [
      progress(f, header - 20, header + 10) * (1 - progress(f, meta - 20, meta)),
      progress(f, meta - 20, meta + 6) * (1 - progress(f, tensors - 20, tensors)),
      progress(f, tensors - 16, tensors + 8) * (1 - progress(f, tensors + 20, tensors + 40)),
      progress(f, tensors + 20, tensors + 40) * (1 - progress(f, tensors + 70, tensors + 90)),
      progress(f, tensors + 40, tensors + 60) * (1 - progress(f, onefile - 10, onefile + 20)),
    ][i];
    return -16 * ease.out(act);
  };

  const glass = tCont; // 變成透明容器
  const {dx, dy, h} = SLAB;
  const r = rng(77);
  const dataCells: {x: number; y: number; o: number}[] = [];
  for (let row = 0; row < 6; row++) {
    for (let c = 0; c < 86; c++) {
      dataCells.push({x: secX[4] + 8 + c * 11.6, y: SLAB.y + 10 + row * 17.5, o: 0.25 + r() * 0.6});
    }
  }

  const hexT = (i: number) => clamp((f - header + 10 - i * 6) / 12);
  const letterT = (i: number) => clamp((f - header - 20 - i * 6) / 12);

  return (
    <>
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
        <defs>
          <linearGradient id="a4slabTop" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={P.paper} stopOpacity={0.5} />
            <stop offset="1" stopColor={P.paper} stopOpacity={0.15} />
          </linearGradient>
          <linearGradient id="a4slabShade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#000" stopOpacity={0} />
            <stop offset="1" stopColor="#000" stopOpacity={0.28} />
          </linearGradient>
          <pattern id="a4padHatch" patternUnits="userSpaceOnUse" width={7} height={7} patternTransform="rotate(45)">
            <line x1={0} y1={0} x2={0} y2={7} stroke={P.mist} strokeWidth={1.4} />
          </pattern>
        </defs>

        {/* 變形中的長條 */}
        {morph < 1 && f >= gguf - 112 ? <rect x={fx} y={fy} width={fw} height={fh} fill={P.amber} fillOpacity={0.9} rx={lerp(0, 4, morph)} /> : null}

        {morph >= 0.999 || tSec > 0 ? (
          <g>
            {/* 地面陰影 */}
            <ellipse cx={(SLAB.x0 + SLAB.x1) / 2 + 30} cy={SLAB.y + h + 40} rx={L * 0.55} ry={26} fill="#000" opacity={0.35 * t3d} />
            {SECS.map((s, i) => {
              const xa = secX[i];
              const xb = secX[i + 1];
              const ly = lift(i);
              const y0 = SLAB.y + ly;
              const isPad = s.id === 'pad';
              const frontO = lerp(lerp(1, 0.92, tSec), 0.16, glass);
              const fill = s.color;
              return (
                <g key={s.id}>
                  {/* 頂面 */}
                  <polygon
                    points={`${xa},${y0} ${xb},${y0} ${xb + dx},${y0 + dy} ${xa + dx},${y0 + dy}`}
                    fill={isPad ? 'url(#a4padHatch)' : fill}
                    opacity={t3d * lerp(0.55, 0.22, glass)}
                  />
                  <polygon points={`${xa},${y0} ${xb},${y0} ${xb + dx},${y0 + dy} ${xa + dx},${y0 + dy}`} fill="url(#a4slabTop)" opacity={t3d * 0.6} />
                  {/* 正面 */}
                  <rect x={xa} y={y0} width={xb - xa} height={h} fill={isPad ? 'url(#a4padHatch)' : lerp(0, 1, tSec) > 0.5 ? fill : P.amber} opacity={frontO} />
                  <rect x={xa} y={y0} width={xb - xa} height={h} fill="url(#a4slabShade)" opacity={1 - glass} />
                  <rect x={xa} y={y0} width={xb - xa} height={h} fill="none" stroke={glass > 0 ? s.color : P.ink} strokeOpacity={lerp(0.5 * tSec, 0.9, glass)} strokeWidth={glass > 0 ? 1.6 : 2} />
                  {/* 右側面（最後一段） */}
                  {i === SECS.length - 1 ? (
                    <polygon
                      points={`${xb},${y0} ${xb + dx},${y0 + dy} ${xb + dx},${y0 + dy + h} ${xb},${y0 + h}`}
                      fill={P.amberDeep}
                      opacity={t3d * lerp(0.95, 0.2, glass)}
                    />
                  ) : null}
                </g>
              );
            })}
            {/* 張量資料的量化方塊紋理 */}
            <g opacity={tSec * (1 - glass) * 0.9}>
              {dataCells.map((c, i) => (
                <rect key={i} x={c.x} y={c.y + lift(4)} width={9} height={13} fill={P.ink} opacity={c.o * 0.32} />
              ))}
            </g>
            {/* 容器內的模型：一層層權重＋分詞器、架構設定 */}
            {glass > 0.01 ? (
              <g opacity={glass}>
                {Array.from({length: 18}).map((_, l) => (
                  <g key={l}>
                    {Array.from({length: 4}).map((__, j) => {
                      const bx = secX[4] + 40 + l * 52 + j * 0;
                      const by = SLAB.y + 14 + j * 24 + wobble(f + l * 9, 90) * 2;
                      return <rect key={j} x={bx} y={by} width={38} height={16} rx={2} fill={P.amber} opacity={0.85 - j * 0.12} />;
                    })}
                  </g>
                ))}
                <rect x={secX[1] + 14} y={SLAB.y + 22} width={secX[2] - secX[1] - 28} height={30} rx={4} fill={P.ice} opacity={0.75} />
                <text x={(secX[1] + secX[2]) / 2} y={SLAB.y + 44} textAnchor="middle" fontFamily={fontStack} fontSize={19} fontWeight={700} fill={P.ink}>
                  架構設定
                </text>
                <rect x={secX[1] + 14} y={SLAB.y + 64} width={secX[2] - secX[1] - 28} height={30} rx={4} fill={P.ice} opacity={0.75} />
                <text x={(secX[1] + secX[2]) / 2} y={SLAB.y + 86} textAnchor="middle" fontFamily={fontStack} fontSize={19} fontWeight={700} fill={P.ink}>
                  分詞器
                </text>
                <text x={(secX[4] + SLAB.x1) / 2} y={SLAB.y + h + 44} textAnchor="middle" fontFamily={fontStack} fontSize={24} fontWeight={700} fill={P.amber}>
                  模型的權重
                </text>
              </g>
            ) : null}
            {/* 容器外框與標籤 */}
            {glass > 0.01 ? (
              <g opacity={glass}>
                <rect x={SLAB.x0 - 1} y={SLAB.y - 1} width={L + 2} height={h + 2} fill="none" stroke={P.paper} strokeWidth={2.4} />
                <polyline points={`${SLAB.x0},${SLAB.y} ${SLAB.x0 + dx},${SLAB.y + dy} ${SLAB.x1 + dx},${SLAB.y + dy} ${SLAB.x1 + dx},${SLAB.y + dy + h} ${SLAB.x1},${SLAB.y + h}`} fill="none" stroke={P.paper} strokeWidth={1.6} strokeOpacity={0.7} />
                <line x1={SLAB.x1} y1={SLAB.y} x2={SLAB.x1 + dx} y2={SLAB.y + dy} stroke={P.paper} strokeWidth={1.6} strokeOpacity={0.7} />
              </g>
            ) : null}
            {/* 一個檔案：掃光 */}
            {tOne > 0 && tOne < 1 ? (
              <rect x={lerp(SLAB.x0 - 120, SLAB.x1, tOne)} y={SLAB.y + dy} width={110} height={h - dy} fill={P.paper} opacity={0.16 * Math.sin(Math.PI * tOne)} />
            ) : null}
          </g>
        ) : null}

        {/* 引線 */}
        <g opacity={calloutO}>
          <Leader x1={(secX[0] + secX[1]) / 2 + dx / 2} y1={SLAB.y + dy / 2 + lift(0)} x2={240} y2={410} t={tHead} color={P.mint} />
          <Leader x1={(secX[1] + secX[2]) / 2 + dx / 2} y1={SLAB.y + dy / 2 + lift(1)} x2={640} y2={410} t={tMeta} color={P.ice} />
          <Leader x1={(secX[2] + secX[3]) / 2 + dx / 2} y1={SLAB.y + dy / 2 + lift(2)} x2={1190} y2={410} t={tInfo} color={P.ice} />
          <Leader x1={(secX[3] + secX[4]) / 2} y1={SLAB.y + h + lift(3)} x2={(secX[3] + secX[4]) / 2} y2={SLAB.y + h + 46} t={tData} color={P.mist} />
          <Leader x1={(secX[4] + SLAB.x1) / 2} y1={SLAB.y + h + lift(4)} x2={(secX[4] + SLAB.x1) / 2 + 60} y2={SLAB.y + h + 46} t={tData} color={P.amber} />
        </g>
      </svg>

      {/* 檔名 */}
      <Block x={SLAB.x1 - 420} y={SLAB.y + h + 30} t={progress(f, gguf - 10, gguf + 30) * (1 - progress(f, header - 40, header - 15))} w={480}>
        <div style={{fontFamily: MONO, fontSize: 24, color: P.paper, textAlign: 'right'}}>
          model<span style={{color: P.amber}}>.gguf</span>
        </div>
      </Block>

      <div style={{opacity: calloutO}}>
        {/* 檔頭 */}
        <Block x={150} y={118} t={tHead} w={440}>
          <div style={{fontSize: 30, fontWeight: 800, color: P.mint, letterSpacing: '0.06em'}}>檔頭</div>
          <div style={{display: 'flex', gap: 10, marginTop: 14}}>
            {['47', '47', '55', '46'].map((b, i) => (
              <div key={i} style={{width: 62, textAlign: 'center'}}>
                <div style={{fontFamily: MONO, fontSize: 26, color: P.paper, border: `1.5px solid ${P.mint}`, borderRadius: 4, padding: '4px 0', opacity: hexT(i)}}>{b}</div>
                <div style={{fontFamily: MONO, fontSize: 30, fontWeight: 700, color: P.amber, marginTop: 4, opacity: letterT(i), transform: `translateY(${(1 - letterT(i)) * -10}px)`}}>
                  {'GGUF'[i]}
                </div>
              </div>
            ))}
          </div>
          <div style={{marginTop: 10, fontFamily: MONO, fontSize: 19, lineHeight: '29px', color: P.mist, opacity: clamp((f - header - 50) / 20)}}>
            <div><span style={{color: P.paper}}>version</span>　版本</div>
            <div><span style={{color: P.paper}}>tensor_count</span>　張量數</div>
            <div><span style={{color: P.paper}}>metadata_kv_count</span>　資料筆數</div>
          </div>
        </Block>

        {/* 中繼資料 */}
        <Block x={620} y={118} t={tMeta} w={540}>
          <div style={{fontSize: 30, fontWeight: 800, color: P.ice, letterSpacing: '0.06em'}}>
            中繼資料 <span style={{fontSize: 20, color: P.mist, fontWeight: 500}}>鍵 = 值</span>
          </div>
          <div style={{marginTop: 12}}>
            <KV k="general.architecture" v='"llama"' vColor={P.amber} t={(f - meta + 6) / 12} />
            <KV k="llama.context_length" v="uint32" t={(f - meta - 4) / 12} />
            <KV k="llama.block_count" v="uint32" t={(f - meta - 12) / 12} />
            <KV k="tokenizer.ggml.model" v="string" t={(f - meta - 20) / 12} />
            <KV k="tokenizer.ggml.tokens" v="[ … ]" t={(f - meta - 28) / 12} />
          </div>
        </Block>

        {/* 張量資訊 */}
        <Block x={1180} y={118} t={tInfo} w={600}>
          <div style={{fontSize: 30, fontWeight: 800, color: P.ice, letterSpacing: '0.06em'}}>
            張量資訊 <span style={{fontSize: 20, color: P.mist, fontWeight: 500}}>每個張量一筆</span>
          </div>
          <div style={{marginTop: 12}}>
            <KV k="name" v="blk.0.attn_q.weight" t={(f - tensors + 6) / 10} />
            <KV k="shape" v="[4096, 4096]" t={(f - tensors - 2) / 10} />
            <KV k="type" v="Q4_K" vColor={P.amber} t={(f - tensors - 10) / 10} />
            <KV k="offset" v="0" t={(f - tensors - 18) / 10} />
          </div>
        </Block>

        {/* 對齊與資料 */}
        <Block x={(secX[3] + secX[4]) / 2 - 420} y={SLAB.y + h + 52} t={tData} w={410}>
          <div style={{fontSize: 21, color: P.mist, textAlign: 'right'}}>對齊填充（預設 32 位元組）</div>
        </Block>
        <Block x={(secX[4] + SLAB.x1) / 2 + 40} y={SLAB.y + h + 44} t={tData} w={600}>
          <div style={{fontSize: 30, fontWeight: 800, color: P.amber, letterSpacing: '0.06em'}}>
            張量資料 <span style={{fontSize: 21, color: P.mist, fontWeight: 500}}>真正的權重，佔絕大部分</span>
          </div>
        </Block>
      </div>

      {/* GGUF 字標 */}
      <Block x={0} y={230} t={progress(f, gguf - 20, gguf + 20) * (1 - progress(f, header - 40, header - 15))} w={1920}>
        <div style={{textAlign: 'center', fontFamily: MONO, fontSize: 110, fontWeight: 700, color: P.paper, letterSpacing: '0.12em'}}>
          GGUF
        </div>
        <div style={{textAlign: 'center', fontSize: 26, color: P.mist, letterSpacing: '0.1em', marginTop: -6}}>一種檔案格式</div>
      </Block>
      {/* 容器標籤 */}
      <Block x={SLAB.x0} y={SLAB.y - 104} t={progress(f, container - 6, container + 24)} w={400}>
        <div style={{fontSize: 30, fontWeight: 800, color: P.paper, letterSpacing: '0.1em'}}>
          容器 <span style={{fontSize: 21, color: P.mist, fontWeight: 500, fontFamily: MONO}}>model.gguf</span>
        </div>
      </Block>

      {/* 容器 */}
      <Block x={0} y={250} t={progress(f, container - 10, container + 25)} w={1920}>
        <div style={{textAlign: 'center', fontSize: 46, fontWeight: 800, color: P.paper, letterSpacing: '0.06em'}}>
          GGUF 是<span style={{color: P.amber}}>檔案格式</span>，不是模型本身
        </div>
      </Block>
    </>
  );
};
