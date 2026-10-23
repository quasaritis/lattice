/** Lands here after GitHub: trade the one-time code for a session, then go back. */
import { completeOAuth } from "../sync/auth.js";
import { claimRecents } from "./recent.js";

completeOAuth()
  .then(async (back) => {
    await claimRecents();
    location.replace(back);
  })
  .catch((e: unknown) => {
    document.getElementById("msg")!.textContent = "Sign-in didn't finish.";
    document.getElementById("detail")!.textContent = e instanceof Error ? e.message : "Try again.";
    document.getElementById("back")!.hidden = false;
  });
