/**
 * A small SVG sketch of a board for the "Your boards" list. Built from the CRDT state, so it
 * matches what's on the board, and kept tiny (strokes simplified, text as lines).
 * It is shown through <img>, which never runs scripts and never loads outside resources.
 */
import type { Doc } from "../crdt/doc.js";
import { boardSvg } from "../draw/board-svg.js";

export function boardPreview(doc: Doc, maxBytes = 55000): string | null {
  return boardSvg(doc, { maxBytes });
}
