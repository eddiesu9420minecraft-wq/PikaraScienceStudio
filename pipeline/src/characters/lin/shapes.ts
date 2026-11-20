// Hand-drawn silhouettes for Lin's head in head-local coordinates (cranium centre = origin,
// top y=-57, chin y=60, face toward +x). Each *_P (profile) and *_Q (three-quarter) pair has the
// same command structure so they can be interpolated point by point.

export const HEAD_P =
  'M -2 -57 C 22 -58 38 -46 43 -24 C 46 -12 46 -6 45 -2 C 44 2 43 6 43 12 C 43 20 44 25 45.5 29 C 46.5 32 45 35 44 36 C 45 37.5 45.5 39.5 44.5 41.5 C 43.5 44 41 45 41.5 47.5 C 42 52 38 56 30 57 C 20 58 10 52 2 44 C -4 39 -10 37 -14 35 C -30 24 -40 10 -42 -12 C -40 -40 -26 -56 -2 -57 Z';
export const HEAD_Q =
  'M -4 -57 C 20 -58 38 -46 42 -24 C 45 -12 46 -6 45 -1 C 45 4 45 8 44 14 C 43 21 42 25 40 30 C 39 33 38 36 36 39 C 35 42 33 45 31 48 C 29 52 27 55 23 57.5 C 18 60 10 60 2 56 C -8 51 -20 45 -30 39 C -34 36 -36 32 -38 28 C -46 14 -48 -4 -46 -16 C -44 -40 -28 -56 -4 -57 Z';

export const BACK_P =
  'M 44 -20 C 52 -42 34 -66 4 -69 C -28 -72 -56 -54 -62 -22 C -67 6 -62 34 -52 56 C -48 62 -38 64 -26 60 C -20 54 -14 46 -8 38 C 2 22 20 0 44 -20 Z';
export const BACK_Q =
  'M 44 -20 C 54 -44 36 -68 2 -70 C -32 -72 -62 -52 -66 -20 C -70 8 -64 36 -54 58 C -50 64 -40 66 -28 62 C -22 56 -16 46 -10 38 C 2 22 20 0 44 -20 Z';
export const FAR_P = 'M 18 -30 C 28 -22 30 8 28 28 C 27 40 24 46 18 48 C 16 40 18 20 12 -20 Z';
export const FAR_Q = 'M 36 -32 C 50 -22 55 8 54 28 C 53 40 50 50 43 55 C 41 46 42 20 32 -20 Z';
export const CAP_P =
  'M 47 -10 C 52 -32 36 -64 4 -69 C -28 -72 -56 -54 -62 -22 C -66 4 -60 28 -54 42 C -46 46 -32 44 -21 38 C -16 26 -17 4 -13 -6 C -6 -16 4 -22 12 -23 C 16 -22 19 -19 21 -16 C 22 -20 25 -23 29 -23 C 33 -21 35 -17 37 -13 C 38 -17 40 -19 42 -19 C 45 -17 47 -13 47 -10 Z';
export const CAP_Q =
  'M 44 -6 C 54 -32 36 -66 2 -70 C -32 -72 -62 -52 -66 -20 C -69 6 -63 28 -56 44 C -52 46 -48 42 -46 34 C -46 18 -43 0 -35 -12 C -26 -20 -14 -24 -6 -24 C -2 -23 1 -21 3 -18 C 5 -22 9 -24 13 -24 C 18 -22 21 -18 23 -14 C 25 -18 29 -20 33 -19 C 38 -16 42 -11 44 -6 Z';
export const PART_P = ['M 31 -44 C 37 -32 41 -22 43 -13', 'M 14 -48 C 22 -38 26 -30 28 -23', 'M -2 -50 C 4 -42 8 -32 9 -23'];
export const PART_Q = ['M 22 -46 C 30 -32 36 -20 39 -9', 'M 2 -48 C 8 -38 10 -30 11 -23', 'M -16 -48 C -14 -40 -12 -30 -10 -22'];
export const STR_P = ['M 26 -55 C 2 -61 -28 -53 -47 -31', 'M -53 -14 C -55 6 -53 22 -47 36', 'M -26 -42 C -36 -28 -37 -8 -31 10', 'M -40 -36 C -48 -20 -48 0 -44 18'];
export const STR_Q = ['M 20 -57 C -4 -63 -32 -55 -51 -31', 'M -57 -14 C -59 8 -57 24 -51 38', 'M -32 -44 C -42 -30 -46 -12 -44 6', 'M -46 -36 C -54 -20 -54 0 -50 20'];
export const SHEEN_P = 'M -45 -38 C -32 -57 -6 -63 18 -58 C -2 -56 -24 -50 -39 -32 Z';
export const SHEEN_Q = 'M -49 -36 C -36 -57 -8 -64 15 -60 C -5 -57 -28 -50 -43 -30 Z';
export const JAW_P = 'M -60 46 C -10 50 20 58 60 60 L 60 80 L -60 80 Z';
export const JAW_Q = 'M -60 40 C -20 48 10 62 60 54 L 60 80 L -60 80 Z';

// Ear outline in (dz, dy) relative to the ear centre; projected with the head yaw.
export const EAR: [number, number][] = [
  [6, -12], [-3, -17], [-10, -8], [-9, 2], [-8, 11], [-3, 17], [3, 15], [6, 13], [5, 6], [6, 0], [7, -6], [8, -10], [6, -12],
];
export const EAR_IN: [number, number][] = [[3, -8], [-3, -10], [-6, -2], [-4, 4], [-3, 8], [0, 10], [2, 7]];

// Loose fringe lock that breaks the hairline (drawn with the cap).
export const LOCK_P = 'M 22 -25 C 30 -19 34 -11 34 -4 C 29 -10 23 -16 15 -21 Z';
export const LOCK_Q = 'M 4 -25 C 10 -17 12 -9 11 -2 C 7 -10 1 -16 -6 -21 Z';
