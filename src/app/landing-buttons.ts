/** "New board" buttons, shared by every page that has one. */
import { api } from "../sync/api.js";
import { rememberBoard } from "./recent.js";

export function wireNewBoardButtons(): void {
  const err = document.getElementById("newError");
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".js-new-board")) {
    btn.addEventListener("click", async () => {
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Opening a fresh board…";
      try {
        const id = await api.createBoard("Untitled board");
        rememberBoard(id, "Untitled board");
        location.href = `/b/${id}`;
      } catch (e) {
        btn.disabled = false;
        btn.textContent = label;
        if (err) {
          err.hidden = false;
          err.textContent = `Couldn't create a board: ${e instanceof Error ? e.message : "unknown error"}`;
        }
      }
    });
  }
}
