import React from 'react';
import * as THREE from 'three';
import {palette as P} from '../../theme/palette';
import {type} from '../../theme/fonts';
import {ease, progress} from '../../lib/anim';
import {buildCamera, project} from '../../lib/camera3d';
import {Anchors, Callout, SchematicTag, vis} from './common';
import {ATT_SLAB, CLUSTERS, EMB_WORDS, Q_EMB, Q_TOKENS, SLAB_N, SLAB_Y} from './data';
import {embedRig, embedTimes, qTokenPos} from './embedRig';

/** 3D 場景上的 2D 標註（與 3D 使用同一個攝影機函式投影）。 */
export const EmbedLabels: React.FC<{frame: number; anchors: Anchors}> = ({frame: f, anchors: A}) => {
  const T = embedTimes(A);
  const cam = buildCamera(embedRig(A)(f));
  const p = (v: THREE.Vector3 | [number, number, number]) => project(cam, Array.isArray(v) ? new THREE.Vector3(...v) : v);
  const spaceO = vis(f, T.start, T.flyA, T.rowA - 50, T.rowA - 10);
  const clusterT = vis(f, T.similar - 20, T.similar + 30, T.rowA - 60, T.rowA - 20);
  const qLabelO = vis(f, T.flyB - 10, T.flyB + 20, T.attention + 30, T.attention + 60);
  const layerO = vis(f, T.layers + 20, T.layers + 60, T.attention - 20, T.attention + 10);
  const attO = vis(f, T.attention + 10, T.attention + 60, T.example - 80, T.example - 50);

  // 群組光暈
  const halos = CLUSTERS.map((c, ci) => {
    const members = EMB_WORDS.filter((w) => w.cluster === ci).map((w) => p(w.pos));
    if (ci === 1) members.push(p(Q_EMB[5]));
    const cx = members.reduce((s, m) => s + m.x, 0) / members.length;
    const cy = members.reduce((s, m) => s + m.y, 0) / members.length;
    const rx = Math.max(...members.map((m) => Math.abs(m.x - cx))) + 70;
    const ry = Math.max(...members.map((m) => Math.abs(m.y - cy))) + 50;
    return {cx, cy, rx, ry, name: c.name};
  });

  // Attention 弧線：在 ATT_SLAB 層裡，從最後一個 token 指向前面每個 token
  const sy = SLAB_Y(ATT_SLAB);
  const last = Q_TOKENS.length - 1;
  const wts = [0.35, 0.05, 0.3, 0.05, 0.08, 0.6, 0.04, 0.5, 0.05];

  return (
    <div style={{position: 'absolute', inset: 0, pointerEvents: 'none'}}>
      {/* 背景詞標籤 */}
      {spaceO > 0
        ? EMB_WORDS.map((w, i) => {
            const q = p(w.pos);
            const o = progress(f, T.start + 20 + i * 4, T.flyA + 10 + i * 4) * spaceO;
            return (
              <div
                key={w.text}
                style={{
                  position: 'absolute',
                  left: q.x + 14,
                  top: q.y - 30,
                  ...type.title,
                  fontSize: 26,
                  color: clusterT > 0.5 ? P.amber : P.paper,
                  opacity: o,
                  whiteSpace: 'nowrap',
                }}
              >
                {w.text}
              </div>
            );
          })
        : null}

      {/* 群組 */}
      {clusterT > 0 ? (
        <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: clusterT}}>
          {halos.map((h) => {
            const s = 0.85 + 0.15 * ease.out(clusterT);
            return <ellipse key={h.name} cx={h.cx + 20} cy={h.cy - 8} rx={h.rx * s} ry={h.ry * s} fill="rgba(255,181,71,0.05)" stroke={P.amber} strokeWidth={1.4} strokeDasharray="5 7" opacity={0.8} />;
          })}
        </svg>
      ) : null}
      {clusterT > 0
        ? halos.map((h) => (
            <div
              key={h.name}
              style={{
                position: 'absolute',
                left: h.cx + 20 - 150,
                width: 300,
                top: h.cy - 8 - h.ry - 40,
                textAlign: 'center',
                ...type.label,
                fontSize: 22,
                color: P.mist,
                opacity: clusterT,
              }}
            >
              {h.name}
            </div>
          ))
        : null}

      {/* 問題 token 標籤 */}
      {qLabelO > 0
        ? Q_TOKENS.map((t, i) => {
            const q = p(qTokenPos(A, i, f));
            const inRow = progress(f, T.rowA, T.rowB);
            const dx = 14 * (1 - inRow);
            const dy = -30 * (1 - inRow) + 30 * inRow;
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: q.x + dx - (inRow > 0.5 ? 60 : 0),
                  width: inRow > 0.5 ? 120 : undefined,
                  textAlign: inRow > 0.5 ? 'center' : 'left',
                  top: q.y + dy,
                  ...type.title,
                  fontSize: 24,
                  color: P.ice,
                  opacity: qLabelO * (inRow > 0.4 && inRow < 0.6 ? 0 : 1),
                  whiteSpace: 'nowrap',
                }}
              >
                {t}
              </div>
            );
          })
        : null}

      {/* Transformer 層標註 */}
      {(() => {
        const top = p([3.8, SLAB_Y(SLAB_N - 1), 1.15]);
        const bot = p([3.8, SLAB_Y(0), 1.15]);
        return (
          <>
            {layerO > 0 ? (
              <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: layerO}}>
                <line x1={top.x + 30} y1={top.y} x2={bot.x + 30} y2={bot.y} stroke={P.mist} strokeWidth={1.4} />
                <line x1={top.x + 22} y1={top.y} x2={top.x + 38} y2={top.y} stroke={P.mist} strokeWidth={1.4} />
                <line x1={bot.x + 22} y1={bot.y} x2={bot.x + 38} y2={bot.y} stroke={P.mist} strokeWidth={1.4} />
              </svg>
            ) : null}
            {layerO > 0 ? (
              <div style={{position: 'absolute', left: top.x - 260, top: top.y - 130, opacity: layerO, whiteSpace: 'nowrap'}}>
                <div style={{...type.title, fontSize: 34, color: P.paper}}>Transformer 層</div>
                <div style={{...type.label, fontSize: 22, color: P.mist, marginTop: 10}}>一層又一層，逐層處理</div>
              </div>
            ) : null}
          </>
        );
      })()}

      {/* 進入其中一層：Attention 預覽 */}
      {attO > 0 ? (
        <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: attO}}>
          {Q_TOKENS.slice(0, last).map((_, i) => {
            const a = qTokenPos(A, last, f);
            const b = qTokenPos(A, i, f);
            const mid = a.clone().add(b).multiplyScalar(0.5);
            mid.y += 0.25 + Math.abs(a.x - b.x) * 0.12;
            const pa = p(a);
            const pb = p(b);
            const pm = p(mid);
            const cxp = 2 * pm.x - (pa.x + pb.x) / 2;
            const cyp = 2 * pm.y - (pa.y + pb.y) / 2;
            const grow = ease.out(progress(f, T.attention + 10 + i * 4, T.attention + 50 + i * 4));
            const w = wts[i];
            return (
              <path
                key={i}
                d={`M ${pa.x} ${pa.y} Q ${cxp} ${cyp} ${pb.x} ${pb.y}`}
                fill="none"
                stroke={P.amber}
                strokeWidth={1.5 + 7 * w}
                strokeLinecap="round"
                opacity={0.25 + 0.75 * w}
                pathLength={1}
                strokeDasharray={`${grow} 1`}
              />
            );
          })}
        </svg>
      ) : null}
      {(() => {
        const q = p([0.6, SLAB_Y(ATT_SLAB) + 1.0, 0]);
        return <Callout x={q.x} y={q.y} dx={110} dy={-110} title="Attention 注意力" sub="每個 token 參考前面的 token" t={attO} color={P.amber} />;
      })()}

      <SchematicTag o={spaceO} text="示意圖（實際為數千維）" />
      <SchematicTag o={vis(f, T.rowA - 10, T.rowA + 20, T.example - 30, T.example)} />
    </div>
  );
};
