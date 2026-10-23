/** The board's colours: marker inks for strokes and outlines, paper stocks for notes. */

export const INK: Record<string, { hex: string; label: string }> = {
  ink: { hex: "#17191e", label: "Black" },
  blue: { hex: "#1f4fd6", label: "Blue" },
  red: { hex: "#df3a2e", label: "Red" },
  green: { hex: "#138a4f", label: "Green" },
  orange: { hex: "#ea7a14", label: "Orange" },
  violet: { hex: "#7444d0", label: "Violet" },
  yellow: { hex: "#f2cf00", label: "Yellow" },
};
export const PEN_COLORS = ["ink", "blue", "red", "green", "orange", "violet"];
export const HL_COLORS = ["yellow", "green", "blue", "red", "orange", "violet"];

export const PAPER: Record<string, { hex: string; label: string }> = {
  sun: { hex: "#ffe36e", label: "Yellow" },
  rose: { hex: "#ffb9d3", label: "Pink" },
  sky: { hex: "#acdcff", label: "Blue" },
  mint: { hex: "#bdeec9", label: "Green" },
  lilac: { hex: "#dccbff", label: "Violet" },
  paper: { hex: "#ffffff", label: "White" },
};
export const PAPER_KEYS = Object.keys(PAPER);

export const inkHex = (c: unknown) => (INK[String(c)] ?? INK.ink).hex;
export const paperHex = (c: unknown) => (PAPER[String(c)] ?? PAPER.sun).hex;

/** Cursor / presence colours: saturated enough to read on white and on every paper stock. */
export const PEER_COLORS = ["#df3a2e", "#1f4fd6", "#138a4f", "#ea7a14", "#7444d0", "#c2187a"];
