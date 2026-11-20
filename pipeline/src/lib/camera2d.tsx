import React from 'react';
import {ease, Key, keyframes} from './anim';

/**
 * 2D 攝影機：cx, cy 為畫面中心對準的世界座標；zoom 以對數空間插值，
 * 推鏡時速度感受一致（不會在高倍率時突然加速）。
 */
export type Cam2D = {cx: number; cy: number; zoom: number};

export const cam2dAt = (frame: number, keys: Key<Cam2D>[]): Cam2D => {
  const logKeys = keys.map((k) => ({...k, v: {cx: k.v.cx, cy: k.v.cy, lz: Math.log(k.v.zoom)}}));
  const v = keyframes(frame, logKeys);
  return {cx: v.cx, cy: v.cy, zoom: Math.exp(v.lz)};
};

/** depth < 1 表示遠景（視差較小）。 */
export const camTransform = (c: Cam2D, depth = 1, W = 1920, H = 1080) => {
  const z = Math.pow(c.zoom, depth);
  const cx = W / 2 + (c.cx - W / 2) * depth;
  const cy = H / 2 + (c.cy - H / 2) * depth;
  return `translate(${W / 2}px, ${H / 2}px) scale(${z}) translate(${-cx}px, ${-cy}px)`;
};

export const CameraLayer: React.FC<{cam: Cam2D; depth?: number; children: React.ReactNode; style?: React.CSSProperties}> = ({
  cam,
  depth = 1,
  children,
  style,
}) => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
      transformOrigin: '0 0',
      transform: camTransform(cam, depth),
      ...style,
    }}
  >
    {children}
  </div>
);

export {ease};
