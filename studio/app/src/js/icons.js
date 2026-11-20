// Line icons (24×24, stroke = currentColor). No emoji (STYLE.md).
const P = {
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  script: 'M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  play: 'M7 4.5v15l12-7.5z',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4',
  queue: 'M4 6h16M4 12h16M4 18h10',
  gauge: 'M4 18a8 8 0 1 1 16 0M12 18l4-6',
  doctor: 'M12 21s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.6-7 10-7 10zM9 12h6M12 9v6',
  publish: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2',
  plus: 'M12 5v14M5 12h14',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  refresh: 'M20 11a8 8 0 0 0-14.3-4.3M4 4v4h4M4 13a8 8 0 0 0 14.3 4.3M20 20v-4h-4',
  check: 'M5 12.5l4.5 4.5L19 7',
  x: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 4l9 16H3zM12 10v4M12 17.5v.01',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.01',
  plug: 'M9 3v5M15 3v5M7 8h10v4a5 5 0 0 1-10 0zM12 17v4',
  inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  speaker: 'M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11',
  stop: 'M6 6h12v12H6z',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  merge: 'M6 3v6a6 6 0 0 0 6 6h6M6 21v-6M15 12l3 3-3 3',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  cpu: 'M7 7h10v10H7zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4',
  revert: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  wrench: 'M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8V20h3.2l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.4 2.4-2.6-.6-.6-2.6z',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  pause: 'M8 5v14M16 5v14',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
};

export function icon(name, size) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (size) { svg.setAttribute('width', size); svg.setAttribute('height', size); }
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', P[name] || P.info);
  if (name === 'play') path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}
export function iconHTML(name) { return icon(name).outerHTML; }
