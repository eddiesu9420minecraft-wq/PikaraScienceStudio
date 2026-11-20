import React from 'react';
import {palette as P} from '../../theme/palette';
import {fontStack, type} from '../../theme/fonts';
import {clamp, ease, lerp, progress, rng, tween} from '../../lib/anim';
import {cam2dAt, CameraLayer} from '../../lib/camera2d';
import type {A5} from './timing';
import {MONO, Rect, rectLerp, win} from './ui';
import {CMD, CMD_PARTS, TERM, TERM_BAR, TERM_BAR_BG, TERM_BG, TERM_FONT, TERM_PAD} from './term';

/**
 * 段落 A：終端機打字 → 視窗收成軟體堆疊（llama.cpp → GGML → 後端 → 硬體）→ 再收回終端機，
 * 交給 3D 筆電螢幕（螢幕貼圖與這裡的終端機位置完全相同）。
 */
const ENGINE: Rect = {x: 860, y: 214, w: 600, h: 128};
const GGML: Rect = {x: 860, y: 404, w: 600, h: 108};
const BACK = {
  cpu: {x: 860, y: 578, w: 140, h: 62} as Rect,
  cuda: {x: 1020, y: 578, w: 140, h: 62} as Rect,
  metal: {x: 1180, y: 578, w: 130, h: 62} as Rect,
  vulkan: {x: 1330, y: 578, w: 130, h: 62} as Rect,
};
const HW_CPU = {x: 930, y: 760};
const HW_GPU = {x: 1090, y: 760};
/** 開場兩個並排面板的外框（終端機從這裡收攏而來） */
export const HOOK_UNION: Rect = {x: 190, y: 300, w: 1540, h: 360};
const FILE: Rect = {x: 330, y: 236, w: 190, h: 236};
const CHAR_W = TERM_FONT * 0.55;

const TOOLS = ['llama-cli', 'llama-server', 'llama-quantize'];

export const stackFold = (a: A5) => a.laptop - 190;

export const StackScene: React.FC<{f: number; a: A5}> = ({f, a}) => {
  const F = stackFold(a);
  const sceneO = 1 - progress(f, a.laptop - 132, a.laptop - 104);
  if (sceneO <= 0) return null;

  const cam = cam2dAt(f, [
    {f: 0, v: {cx: 960, cy: 540, zoom: 1.0}},
    {f: a.engine - 20, v: {cx: 960, cy: 530, zoom: 1.035}, ease: ease.inOutSoft},
    {f: a.engine + 60, v: {cx: 905, cy: 520, zoom: 1.0}, ease: ease.camera},
    {f: a.cuda, v: {cx: 915, cy: 525, zoom: 1.03}, ease: ease.inOutSoft},
    {f: F + 56, v: {cx: 960, cy: 540, zoom: 1.0}, ease: ease.camera},
  ]);

  // 打字
  const typeStart = Math.max(40, a.hook + 96);
  const chars = Math.floor(tween(f, typeStart, Math.max(typeStart + 120, a.intro - 34), 0, CMD.length, ease.linear));
  const enter = f > a.intro - 24;
  const titleT = progress(f, a.intro - 18, a.intro + 26);

  // 視窗 ↔ 引擎方塊
  const toBlock = ease.camera(progress(f, a.engine - 22, a.engine + 40));
  const back = ease.camera(progress(f, F + 12, F + 58));
  const m = toBlock * (1 - back);
  const enterT = ease.camera(progress(f, a.hook + 26, a.hook + 82));
  const winO = progress(f, a.hook + 24, a.hook + 46);
  const box = rectLerp(rectLerp(HOOK_UNION, TERM, enterT), ENGINE, m);
  const termTextO = Math.max(1 - progress(f, a.engine - 22, a.engine + 6), progress(f, F + 40, F + 60));
  const blockO = progress(f, a.engine - 4, a.engine + 26) * (1 - progress(f, F, F + 18));
  const fold = ease.inOut(progress(f, F, F + 40)); // 其他元件收回
  const foldO = 1 - fold;

  // C/C++ 原始碼頁（a5-02 前半）
  const codeT = win(f, a.engine - 250, a.engine - 200, a.engine - 30, a.engine + 10);

  // 模型檔名飛出 → 成為左側 GGUF 檔
  const fly = ease.camera(progress(f, a.engine - 6, a.engine + 54));
  const tokenStart = {x: TERM.x + TERM_PAD + CHAR_W * (2 + 9 + 4), y: TERM.y + TERM_BAR + 64 - TERM_FONT * 0.72};
  const tokenEnd = {x: FILE.x + FILE.w / 2 - (17 * 22 * 0.55) / 2, y: FILE.y + FILE.h + 22};
  const fileT = progress(f, a.notmodel - 40, a.notmodel + 16);
  const neqT = progress(f, a.notmodel + 10, a.notmodel + 50);
  const feedT = progress(f, a.notmodel + 60, a.notmodel + 110);

  const toolT = (i: number) => { const s = Math.min(a.tools - 14, a.engine + 30); return ease.out(progress(f, s + i * 9, s + 36 + i * 9)); };
  const ggmlT = ease.out(progress(f, a.ggml - 170, a.ggml - 110));
  const ggmlSub = progress(f, a.ggml - 20, a.ggml + 20);
  const cpuB = ease.out(progress(f, a.cpu - 34, a.cpu + 4));
  const cudaB = ease.out(progress(f, a.cuda - 34, a.cuda + 4));
  const otherB = ease.out(progress(f, a.cuda + 26, a.cuda + 60));
  const cpuPath = progress(f, a.cpu - 8, a.cpu + 48);
  const cudaPath = progress(f, a.cuda - 8, a.cuda + 48);

  // 收回時每個元件朝引擎中心靠攏
  const pull = (x: number, y: number) => ({
    x: lerp(x, ENGINE.x + ENGINE.w / 2, fold * 0.85),
    y: lerp(y, ENGINE.y + ENGINE.h / 2, fold * 0.85),
    s: 1 - fold * 0.6,
  });

  const typed = (() => {
    let left = chars;
    return CMD_PARTS.map((p, i) => {
      const n = clamp(left, 0, p.text.length);
      left -= p.text.length;
      const txt = p.text.slice(0, n);
      const hide = p.key === 'model' && f > a.engine - 6 && back < 0.5;
      const glow = p.key === 'bin' ? progress(f, a.intro - 10, a.intro + 10) * (1 - progress(f, a.engine - 30, a.engine)) : 0;
      return (
        <span
          key={i}
          style={{
            color: p.color,
            opacity: hide ? 0 : 1,
            textShadow: glow > 0 ? `0 0 ${14 * glow}px rgba(92,200,255,${0.7 * glow})` : undefined,
            background: glow > 0 ? `rgba(92,200,255,${0.12 * glow})` : undefined,
          }}
        >
          {txt}
        </span>
      );
    });
  })();

  const cursorOn = Math.floor(f / 28) % 2 === 0;

  return (
    <div style={{position: 'absolute', inset: 0, opacity: sceneO}}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `radial-gradient(ellipse 60% 55% at 50% 45%, rgba(28,39,64,0.55) 0%, rgba(9,13,24,0) 100%)`,
        }}
      />
      <CameraLayer cam={cam}>
        {/* 原始碼縮圖（C / C++） */}
        {codeT > 0 ? <CodePages t={codeT} /> : null}

        {/* 標題 llama.cpp */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            width: 1920,
            top: lerp(176, 130, toBlock),
            textAlign: 'center',
            opacity: titleT * (1 - progress(f, a.engine - 30, a.engine + 6)),
            transform: `translateY(${(1 - titleT) * 14}px)`,
          }}
        >
          <div style={{fontFamily: MONO, fontWeight: 600, fontSize: 84, color: P.paper, letterSpacing: '0.01em'}}>
            llama<span style={{color: P.amber}}>.cpp</span>
          </div>
          <div style={{...type.label, fontFamily: fontStack, fontSize: 26, color: P.mist, marginTop: 6, opacity: codeT}}>
            C / C++　·　開源
          </div>
        </div>

        {/* 堆疊連線（光路） */}
        <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: foldO}}>
          <StackPaths f={f} ggmlT={ggmlT} cpuPath={cpuPath} cudaPath={cudaPath} feedT={feedT} />
        </svg>

        {/* GGUF 檔（模型 = 資料） */}
        <FileIcon t={fileT * foldO} f={f} />
        {neqT > 0 ? (
          <div
            style={{
              position: 'absolute',
              left: 600,
              top: 196,
              width: 200,
              textAlign: 'center',
              opacity: neqT * foldO,
              fontFamily: fontStack,
            }}
          >
            <div style={{fontSize: 76, color: P.mist, fontWeight: 300, lineHeight: 1}}>≠</div>
          </div>
        ) : null}
        {/* 飛行中的檔名 */}
        <div
          style={{
            position: 'absolute',
            left: lerp(tokenStart.x, tokenEnd.x, fly),
            top: lerp(tokenStart.y, tokenEnd.y, fly) - Math.sin(fly * Math.PI) * 60,
            fontFamily: MONO,
            fontSize: lerp(TERM_FONT, 22, fly),
            color: P.amber,
            whiteSpace: 'nowrap',
            opacity: f > a.engine - 6 ? foldO : 0,
            transform: `translate(${(1 - foldO) * 200}px, ${-(1 - foldO) * 60}px)`,
          }}
        >
          model-Q4_K_M.gguf
        </div>
        {fileT > 0 ? (
          <div
            style={{
              position: 'absolute',
              left: FILE.x - 80,
              width: FILE.w + 160,
              top: FILE.y + FILE.h + 66,
              textAlign: 'center',
              ...type.label,
              fontSize: 26,
              color: P.paper,
              opacity: progress(fileT, 0.4, 1) * foldO,
            }}
          >
            AI 模型＝資料
          </div>
        ) : null}

        {/* 工具 */}
        {TOOLS.map((tl, i) => {
          const t = toolT(i) * foldO;
          if (t <= 0) return null;
          const x0 = ENGINE.x + 85 + i * 215;
          const p = pull(x0, 150);
          return (
            <div
              key={tl}
              style={{
                position: 'absolute',
                left: p.x - 100,
                top: p.y - 22 + (1 - t) * 40,
                width: 200,
                height: 44,
                textAlign: 'center',
                opacity: t,
                transform: `scale(${p.s})`,
                fontFamily: MONO,
                fontSize: 22,
                lineHeight: '44px',
                color: P.ice,
                borderBottom: `1.5px solid rgba(92,200,255,0.55)`,
                borderLeft: `1.5px solid rgba(92,200,255,0.25)`,
                borderRight: `1.5px solid rgba(92,200,255,0.25)`,
              }}
            >
              {tl}
            </div>
          );
        })}

        {/* GGML */}
        {ggmlT > 0 ? (
          <Block
            r={{...GGML, y: GGML.y + (1 - ggmlT) * 60 - fold * 120}}
            o={ggmlT * foldO}
            title="GGML"
            sub="張量運算函式庫"
            subO={ggmlSub}
            glyph={<TensorGlyph f={f} />}
          />
        ) : null}

        {/* 後端 */}
        <Backend r={BACK.cpu} t={cpuB * foldO} label="CPU" lit={cpuPath} color={P.amber} fold={fold} />
        <Backend r={BACK.cuda} t={cudaB * foldO} label="CUDA" lit={cudaPath} color={P.ice} fold={fold} />
        <Backend r={BACK.metal} t={otherB * foldO} label="Metal" lit={0} color={P.mist} fold={fold} dim />
        <Backend r={BACK.vulkan} t={otherB * foldO} label="Vulkan" lit={0} color={P.mist} fold={fold} dim />
        {otherB > 0 ? (
          <div
            style={{
              position: 'absolute',
              left: 1182,
              top: 652,
              width: 280,
              textAlign: 'center',
              ...type.label,
              fontSize: 19,
              color: P.mist,
              opacity: otherB * foldO * 0.85,
            }}
          >
            其他後端
          </div>
        ) : null}
        {cpuB > 0 ? (
          <div style={{position: 'absolute', left: 560, top: 590, width: 280, textAlign: 'right', ...type.label, fontSize: 22, color: P.mist, opacity: cpuB * foldO}}>
            後端 backend
          </div>
        ) : null}

        {/* 硬體 */}
        <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: foldO}}>
          <CpuIcon x={HW_CPU.x} y={HW_CPU.y} t={progress(cpuPath, 0.55, 1)} glow={progress(cpuPath, 0.85, 1)} />
          <GpuIcon x={HW_GPU.x + 30} y={HW_GPU.y} t={progress(cudaPath, 0.55, 1)} glow={progress(cudaPath, 0.85, 1)} />
        </svg>
        {cudaPath > 0.6 ? (
          <div
            style={{
              position: 'absolute',
              left: HW_GPU.x + 120,
              top: HW_GPU.y - 18,
              ...type.label,
              fontSize: 22,
              color: P.ice,
              opacity: progress(cudaPath, 0.7, 1) * foldO,
              whiteSpace: 'nowrap',
            }}
          >
            NVIDIA 顯示卡
          </div>
        ) : null}

        {/* 視窗 / 引擎方塊（同一個物件） */}
        <div
          style={{
            position: 'absolute',
            left: box.x,
            top: box.y,
            width: box.w,
            height: box.h,
            background: TERM_BG,
            border: `2px solid ${m > 0.5 ? 'rgba(255,181,71,0.55)' : P.line}`,
            borderRadius: 14,
            overflow: 'hidden',
            opacity: winO,
            boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
          }}
        >
          <div style={{height: TERM_BAR * (1 - m), background: TERM_BAR_BG, position: 'relative', opacity: termTextO}}>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{position: 'absolute', left: 20 + i * 24, top: TERM_BAR / 2 - 6, width: 12, height: 12, borderRadius: 6, background: 'rgba(138,151,180,0.45)'}}
              />
            ))}
            <div style={{position: 'absolute', left: 0, right: 0, top: 0, lineHeight: `${TERM_BAR}px`, textAlign: 'center', fontFamily: MONO, fontSize: 18, color: P.mist}}>
              terminal
            </div>
          </div>
          <div
            style={{
              position: 'absolute',
              left: TERM_PAD,
              top: TERM_BAR + 64 - TERM_FONT * 0.78,
              fontFamily: MONO,
              fontWeight: 500,
              fontSize: TERM_FONT,
              whiteSpace: 'pre',
              opacity: termTextO,
              lineHeight: 1.1,
            }}
          >
            <span style={{color: P.mist}}>$ </span>
            {typed}
            {!enter ? <span style={{display: 'inline-block', width: 18, height: 36, background: cursorOn ? P.paper : 'transparent', verticalAlign: '-6px', marginLeft: 2}} /> : null}
          </div>
          {enter ? (
            <div
              style={{
                position: 'absolute',
                left: TERM_PAD,
                top: TERM_BAR + 128 - TERM_FONT * 0.78,
                fontFamily: MONO,
                fontSize: TERM_FONT,
                whiteSpace: 'pre',
                color: P.mist,
                opacity: termTextO,
                lineHeight: 1.1,
              }}
            >
              {'> '}
              <span style={{display: 'inline-block', width: 18, height: 36, background: cursorOn || f > F ? P.paper : 'transparent', verticalAlign: '-6px'}} />
            </div>
          ) : null}
          {/* 引擎方塊內容 */}
          {blockO > 0 ? (
            <div style={{position: 'absolute', inset: 0, opacity: blockO, display: 'flex', alignItems: 'center', paddingLeft: 40}}>
              <div style={{fontFamily: MONO, fontWeight: 600, fontSize: 46, color: P.paper}}>
                llama<span style={{color: P.amber}}>.cpp</span>
              </div>
              <div style={{marginLeft: 36, fontFamily: fontStack}}>
                <div style={{...type.title, fontSize: 30, color: P.amber}}>推理引擎</div>
                <div style={{...type.label, fontSize: 20, color: P.mist, marginTop: 4}}>執行模型的程式</div>
              </div>
              <EnginePulse f={f} />
            </div>
          ) : null}
        </div>
      </CameraLayer>
    </div>
  );
};

// ---------------------------------------------------------------------------

const Block: React.FC<{r: Rect; o: number; title: string; sub: string; subO: number; glyph?: React.ReactNode}> = ({r, o, title, sub, subO, glyph}) => (
  <div
    style={{
      position: 'absolute',
      left: r.x,
      top: r.y,
      width: r.w,
      height: r.h,
      opacity: o,
      background: TERM_BG,
      border: `2px solid ${P.line}`,
      borderRadius: 14,
      display: 'flex',
      alignItems: 'center',
      paddingLeft: 40,
      boxSizing: 'border-box',
    }}
  >
    <div style={{fontFamily: MONO, fontWeight: 600, fontSize: 44, color: P.paper}}>{title}</div>
    <div style={{marginLeft: 36, ...type.title, fontSize: 28, color: P.paper, opacity: subO}}>{sub}</div>
    <div style={{position: 'absolute', right: 28, top: (r.h - 64) / 2}}>{glyph}</div>
  </div>
);

const TensorGlyph: React.FC<{f: number}> = ({f}) => {
  const cells = [];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      const v = Math.sin(i * 1.3 + j * 0.7 + f * 0.05);
      cells.push(
        <rect key={i * 4 + j} x={j * 16} y={i * 16} width={13} height={13} rx={2} fill={v > 0 ? P.amber : P.ice} opacity={0.25 + 0.6 * Math.abs(v)} />,
      );
    }
  return (
    <svg width={64} height={64}>
      {cells}
    </svg>
  );
};

const EnginePulse: React.FC<{f: number}> = ({f}) => (
  <svg width={72} height={60} style={{position: "absolute", right: 26, top: 34}}>
    {Array.from({length: 5}).map((_, i) => {
      const h = 14 + 30 * Math.abs(Math.sin(f * 0.07 + i * 0.9));
      return <rect key={i} x={i * 15} y={(60 - h) / 2} width={8} height={h} rx={3} fill={P.amber} opacity={0.55} />;
    })}
  </svg>
);

const Backend: React.FC<{r: Rect; t: number; label: string; lit: number; color: string; fold: number; dim?: boolean}> = ({r, t, label, lit, color, fold, dim}) => {
  if (t <= 0.001) return null;
  const y = r.y + (1 - t) * 30 - fold * 280;
  const l = progress(lit, 0.3, 0.6);
  return (
    <div
      style={{
        position: 'absolute',
        left: r.x,
        top: y,
        width: r.w,
        height: r.h,
        opacity: t * (dim ? 0.45 : 1),
        border: `2px solid ${dim ? P.line : l > 0 ? color : P.line}`,
        borderRadius: 10,
        background: l > 0 && !dim ? `rgba(${color === P.amber ? '255,181,71' : '92,200,255'},${0.12 * l})` : TERM_BG,
        textAlign: 'center',
        lineHeight: `${r.h - 4}px`,
        fontFamily: MONO,
        fontSize: 26,
        fontWeight: 600,
        color: dim ? P.mist : l > 0.5 ? color : P.paper,
        boxSizing: 'border-box',
      }}
    >
      {label}
    </div>
  );
};

/** 光路：引擎 → GGML → 後端 → 硬體；以 dash 揭示，再有光點流動 */
const StackPaths: React.FC<{f: number; ggmlT: number; cpuPath: number; cudaPath: number; feedT: number}> = ({f, ggmlT, cpuPath, cudaPath, feedT}) => {
  const ex = ENGINE.x + ENGINE.w / 2;
  const trunk = `M ${ex} ${ENGINE.y + ENGINE.h} L ${ex} ${GGML.y}`;
  const cpu = `M ${ex - 60} ${GGML.y + GGML.h} L ${ex - 60} ${GGML.y + GGML.h + 24} L ${930} ${GGML.y + GGML.h + 24} L 930 ${BACK.cpu.y} M 930 ${BACK.cpu.y + BACK.cpu.h} L 930 ${HW_CPU.y - 46}`;
  const cuda = `M ${ex - 30} ${GGML.y + GGML.h} L ${ex - 30} ${GGML.y + GGML.h + 40} L 1090 ${GGML.y + GGML.h + 40} L 1090 ${BACK.cuda.y} M 1090 ${BACK.cuda.y + BACK.cuda.h} L 1090 ${HW_GPU.y - 46}`;
  const feed = `M ${FILE.x + FILE.w + 16} ${FILE.y + FILE.h / 2} C 700 ${FILE.y + FILE.h / 2}, 760 ${ENGINE.y + ENGINE.h / 2}, ${ENGINE.x - 12} ${ENGINE.y + ENGINE.h / 2}`;
  const L = 600;
  return (
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      {ggmlT > 0 ? <path d={trunk} stroke={P.line} strokeWidth={3} opacity={ggmlT} /> : null}
      {cpuPath > 0 ? (
        <>
          <path d={cpu} stroke={P.amber} strokeWidth={3} strokeDasharray={`${L * cpuPath} ${L}`} opacity={0.85} />
          <path d={cpu} stroke="#FFE2B0" strokeWidth={5} strokeDasharray="10 70" strokeDashoffset={-f * 3} opacity={0.7 * progress(cpuPath, 0.9, 1)} />
        </>
      ) : null}
      {cudaPath > 0 ? (
        <>
          <path d={cuda} stroke={P.ice} strokeWidth={3} strokeDasharray={`${L * cudaPath} ${L}`} opacity={0.85} />
          <path d={cuda} stroke="#CDEFFF" strokeWidth={5} strokeDasharray="10 70" strokeDashoffset={-f * 3} opacity={0.7 * progress(cudaPath, 0.9, 1)} />
        </>
      ) : null}
      {(cpuPath > 0 || cudaPath > 0) && ggmlT > 0 ? (
        <path d={trunk} stroke={P.paper} strokeWidth={5} strokeDasharray="10 50" strokeDashoffset={-f * 3} opacity={0.5 * Math.max(cpuPath, cudaPath)} />
      ) : null}
      {feedT > 0 ? (
        <>
          <path d={feed} stroke={P.amber} strokeWidth={2.5} strokeDasharray={`${420 * feedT} 600`} opacity={0.7} />
          <path d={feed} stroke={P.amber} strokeWidth={5} strokeDasharray="8 40" strokeDashoffset={-f * 2.2} opacity={0.8 * progress(feedT, 0.8, 1)} />
          <text x={735} y={ENGINE.y + ENGINE.h / 2 + 92} fill={P.mist} fontSize={21} fontFamily={fontStack} textAnchor="middle" opacity={progress(feedT, 0.6, 1)}>
            讀取並執行
          </text>
        </>
      ) : null}
    </g>
  );
};

const FileIcon: React.FC<{t: number; f: number}> = ({t, f}) => {
  if (t <= 0.001) return null;
  const {x, y, w, h} = FILE;
  const c = 42;
  const per = 2 * (w + h);
  const d = `M ${x} ${y} L ${x + w - c} ${y} L ${x + w} ${y + c} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
  const rows = rng(5);
  return (
    <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
      <path d={d} fill={`rgba(255,181,71,${0.07 * t})`} stroke={P.amber} strokeWidth={2.5} strokeDasharray={`${per * t} ${per}`} />
      <path d={`M ${x + w - c} ${y} L ${x + w - c} ${y + c} L ${x + w} ${y + c}`} fill="none" stroke={P.amber} strokeWidth={2} opacity={t} />
      <text x={x + 26} y={y + 54} fill={P.amber} fontFamily={MONO} fontSize={28} fontWeight={700} opacity={progress(t, 0.5, 1)}>
        GGUF
      </text>
      {Array.from({length: 7}).map((_, i) => {
        const len = 50 + rows() * 90;
        return (
          <rect
            key={i}
            x={x + 26}
            y={y + 84 + i * 20}
            width={len * progress(t, 0.4 + i * 0.05, 0.8 + i * 0.03)}
            height={8}
            rx={3}
            fill={P.amber}
            opacity={0.25 + 0.2 * Math.sin(f * 0.04 + i)}
          />
        );
      })}
    </svg>
  );
};

const CpuIcon: React.FC<{x: number; y: number; t: number; glow: number}> = ({x, y, t, glow}) => {
  if (t <= 0) return null;
  const s = 84;
  return (
    <g opacity={t} transform={`translate(${x} ${y + (1 - t) * 20})`}>
      {Array.from({length: 7}).map((_, i) => (
        <g key={i}>
          <rect x={-s / 2 + 8 + i * 11} y={-s / 2 - 9} width={5} height={9} fill={P.gold} opacity={0.8} />
          <rect x={-s / 2 + 8 + i * 11} y={s / 2} width={5} height={9} fill={P.gold} opacity={0.8} />
          <rect x={-s / 2 - 9} y={-s / 2 + 8 + i * 11} width={9} height={5} fill={P.gold} opacity={0.8} />
          <rect x={s / 2} y={-s / 2 + 8 + i * 11} width={9} height={5} fill={P.gold} opacity={0.8} />
        </g>
      ))}
      <rect x={-s / 2} y={-s / 2} width={s} height={s} rx={6} fill="#1F3A2E" stroke={P.amber} strokeOpacity={0.3 + 0.7 * glow} strokeWidth={2} />
      <rect x={-24} y={-24} width={48} height={48} rx={4} fill="#9AA3B5" />
      <text x={0} y={9} textAnchor="middle" fontFamily={MONO} fontWeight={700} fontSize={22} fill="#1A2030">
        CPU
      </text>
    </g>
  );
};

const GpuIcon: React.FC<{x: number; y: number; t: number; glow: number}> = ({x, y, t, glow}) => {
  if (t <= 0) return null;
  return (
    <g opacity={t} transform={`translate(${x} ${y + (1 - t) * 20})`}>
      <rect x={-90} y={-42} width={150} height={84} rx={6} fill="#173229" stroke={P.ice} strokeOpacity={0.3 + 0.7 * glow} strokeWidth={2} />
      <rect x={-56} y={-22} width={44} height={44} rx={3} fill="#2A3245" />
      <rect x={-49} y={-15} width={30} height={30} rx={2} fill="#3D4A66" />
      {[-30, 0, 30].map((dy, i) => (
        <rect key={i} x={10} y={dy - 9} width={26} height={18} rx={2} fill="#14161D" stroke={P.ice} strokeOpacity={0.35} />
      ))}
      <rect x={-80} y={42} width={90} height={7} fill={P.gold} opacity={0.8} />
    </g>
  );
};

const CodePages: React.FC<{t: number}> = ({t}) => {
  const r = rng(77);
  const page = (x0: number, label: string, dir: number) => (
    <div
      style={{
        position: 'absolute',
        left: x0,
        top: 300,
        width: 220,
        height: 360,
        opacity: t * 0.9,
        transform: `translateX(${(1 - t) * 40 * dir}px)`,
      }}
    >
      <div style={{fontFamily: MONO, fontSize: 20, color: P.mist, marginBottom: 14}}>{label}</div>
      <svg width={220} height={320}>
        {Array.from({length: 16}).map((_, i) => {
          const indent = Math.floor(r() * 3) * 18;
          const len = 40 + r() * 120;
          const col = r() > 0.75 ? P.amber : r() > 0.6 ? P.ice : P.mist;
          return <rect key={i} x={indent} y={i * 19} width={len} height={7} rx={3} fill={col} opacity={col === P.mist ? 0.35 : 0.55} />;
        })}
      </svg>
    </div>
  );
  return (
    <>
      {page(118, 'llama.cpp', -1)}
      {page(1588, 'ggml.c', 1)}
    </>
  );
};
