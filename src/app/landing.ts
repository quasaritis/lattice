import { api } from "../sync/api.js";
import { LabView } from "./labview.js";

export function wireNewBoardButtons(): void {
  const err = document.getElementById("newError");
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".js-new-board")) {
    btn.addEventListener("click", async () => {
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Creating board…";
      try {
        const id = await api.createBoard("Untitled board");
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

wireNewBoardButtons();

const hero = document.getElementById("heroLab");
if (hero) new LabView(hero, { labels: ["Asha", "Rohan"], autoplay: true, network: { minLatency: 150, maxLatency: 650, drop: 0.08, duplicate: 0.1 } });
