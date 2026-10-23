import { mountAccount } from "./account.js";
import { wireNewBoardButtons } from "./landing-buttons.js";
import { LabView } from "./labview.js";

const root = document.getElementById("lab");
if (root) new LabView(root, { labels: ["Asha", "Rohan", "Meera"], full: true, startText: "Demo day at 6. Slides by Rohan" });
const account = document.getElementById("account");
if (account) mountAccount(account);
wireNewBoardButtons();
