/** One icon family, drawn for Lattice: 24px grid, 1.75 stroke, round joins. */

const wrap = (body: string, fill = false) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="${fill ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICON = {
  select: wrap(`<path d="M5.5 3.8 18.6 11.4l-5.9 1.4-2.9 5.6z"/>`),
  hand: wrap(`<path d="M8 12.5V6.2a1.6 1.6 0 0 1 3.2 0v5"/><path d="M11.2 11V4.8a1.6 1.6 0 0 1 3.2 0V11"/><path d="M14.4 11.2V6.6a1.6 1.6 0 0 1 3.2 0v7.2a6.6 6.6 0 0 1-6.6 6.6h-.6a6 6 0 0 1-4.6-2.2l-2.6-3.3a1.6 1.6 0 0 1 2.4-2.1L8 14"/>`),
  pen: wrap(`<path d="M15.6 4.6a2.1 2.1 0 0 1 3 3L8.2 18l-4 1.1 1.1-4z"/><path d="m13.8 6.4 3 3"/>`),
  marker: wrap(`<path d="m9.2 15.4-2.6-2.6 8.6-8.6a1.85 1.85 0 0 1 2.6 2.6z"/><path d="m6.6 12.8-2.4 4.6 1.2 1.2 4.6-2.4"/><path d="M4 20.6h7" stroke-width="2.6"/>`),
  highlighter: wrap(`<path d="m9 14.6-2.6-2.6 7.9-7.9 4.5 4.5z"/><path d="m6.4 12-2.1 4.2 2.4 2.4L11 16.5"/><path d="M12.5 20.5h8" stroke-width="3" opacity=".55"/>`),
  arrow: wrap(`<path d="M5 19 18.5 5.5"/><path d="M9.5 5.2h9.3v9.3"/>`),
  eraser: wrap(`<path d="m7.5 19.5-3.3-3.3a1.8 1.8 0 0 1 0-2.6l8.9-8.9a1.8 1.8 0 0 1 2.6 0l4.2 4.2a1.8 1.8 0 0 1 0 2.6l-7.9 8z"/><path d="M8.8 9.9 14.4 15.5"/><path d="M7.5 19.5h12.7"/>`),
  note: wrap(`<path d="M4.5 5.2c0-.4.3-.7.7-.7h13.6c.4 0 .7.3.7.7V14l-5.5 5.5H5.2a.7.7 0 0 1-.7-.7z"/><path d="M14 19.5v-4.8a.7.7 0 0 1 .7-.7h4.8"/>`),
  text: wrap(`<path d="M5.5 6.5V5h13v1.5"/><path d="M12 5v14"/><path d="M9.2 19h5.6"/>`),
  rect: wrap(`<rect x="3.8" y="5.8" width="16.4" height="12.4" rx="2.6"/>`),
  ellipse: wrap(`<ellipse cx="12" cy="12" rx="8.6" ry="6.6"/>`),
  image: wrap(`<rect x="3.6" y="4.6" width="16.8" height="14.8" rx="2.4"/><circle cx="9" cy="9.6" r="1.6"/><path d="m4.4 17.4 5.2-5 3.8 3.4 2.2-1.9 4.6 4"/>`),
  undo: wrap(`<path d="M9 7.5 4.8 11.6 9 15.7"/><path d="M5.2 11.6h9.3a4.8 4.8 0 0 1 0 9.6h-2.6"/>`),
  redo: wrap(`<path d="m15 7.5 4.2 4.1-4.2 4.1"/><path d="M18.8 11.6H9.5a4.8 4.8 0 0 0 0 9.6h2.6"/>`),
  link: wrap(`<path d="M10.2 13.8a3.8 3.8 0 0 0 5.4 0l3-3a3.8 3.8 0 0 0-5.4-5.4l-1 1"/><path d="M13.8 10.2a3.8 3.8 0 0 0-5.4 0l-3 3a3.8 3.8 0 0 0 5.4 5.4l1-1"/>`),
  wifi: wrap(`<path d="M2.8 8.8a13.2 13.2 0 0 1 18.4 0"/><path d="M5.9 12.2a8.6 8.6 0 0 1 12.2 0"/><path d="M9 15.5a4.2 4.2 0 0 1 6 0"/><circle cx="12" cy="18.8" r=".9" fill="currentColor"/>`),
  wifiOff: wrap(`<path d="m3.5 3.5 17 17"/><path d="M9 15.5a4.2 4.2 0 0 1 6 0"/><path d="M5.9 12.2a8.6 8.6 0 0 1 3.5-2.1"/><path d="M2.8 8.8a13.3 13.3 0 0 1 3.4-2.4"/><path d="M14.6 10.1a8.6 8.6 0 0 1 3.5 2.1"/><path d="M11 5.5a13.2 13.2 0 0 1 10.2 3.3"/><circle cx="12" cy="18.8" r=".9" fill="currentColor"/>`),
  trash: wrap(`<path d="M4.5 7h15"/><path d="M9.5 7V4.8h5V7"/><path d="m6.6 7 .9 12.6c.1.8.7 1.4 1.5 1.4h6c.8 0 1.4-.6 1.5-1.4L17.4 7"/>`),
  rotate: wrap(`<path d="M19.2 12.6A7.2 7.2 0 1 1 16.9 6.8"/><path d="M17.6 3.2v3.9h-3.9"/><rect x="9.4" y="9.6" width="5.2" height="5.2" rx="1"/>`),
  plus: wrap(`<path d="M12 5v14M5 12h14"/>`),
  minus: wrap(`<path d="M5 12h14"/>`),
  fit: wrap(`<path d="M4.5 9V4.5H9"/><path d="M15 4.5h4.5V9"/><path d="M19.5 15v4.5H15"/><path d="M9 19.5H4.5V15"/>`),
  boards: wrap(`<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>`),
  user: wrap(`<circle cx="12" cy="8.6" r="3.8"/><path d="M4.8 20.2a7.4 7.4 0 0 1 14.4 0"/>`),
  logout: wrap(`<path d="M14.5 4.5h3.3c.8 0 1.4.6 1.4 1.4v12.2c0 .8-.6 1.4-1.4 1.4h-3.3"/><path d="M10 8 6 12l4 4"/><path d="M6.2 12h9.6"/>`),
  close: wrap(`<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>`),
  check: wrap(`<path d="m5 12.5 4.3 4.3L19 7"/>`),
  github: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor"><path d="M12 2.2a10 10 0 0 0-3.16 19.48c.5.1.68-.21.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.98 1.03-2.68-.1-.26-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.3 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.85-2.34 4.7-4.57 4.95.36.31.68.92.68 1.86v2.75c0 .27.18.59.69.48A10 10 0 0 0 12 2.2z"/></svg>`,
} as const;

export type IconName = keyof typeof ICON;

export function icon(name: IconName): string {
  return ICON[name];
}
