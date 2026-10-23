import { LabView } from "./labview.js";
import { api } from "../sync/api.js";

const root = document.getElementById("lab");
if (root) new LabView(root, { labels: ["Asha", "Rohan", "Meera"], full: true, startText: "Demo day at 6. Slides by Rohan" });

for (const btn of document.querySelectorAll<HTMLButtonElement>(".js-new-board")) {
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Creating board…";
    try {
      location.href = `/b/${await api.createBoard("Untitled board")}`;
    } catch {
      btn.disabled = false;
      btn.textContent = "Try again";
    }
  });
}
