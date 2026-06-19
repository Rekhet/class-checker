"use strict";
// Mount the HTML partials listed in #app[data-partials] (comma-separated, in order),
// then load app.js. A missing/optional partial (e.g. the dev panels in production)
// is skipped silently; app.js guards any nodes that didn't get mounted.
(async () => {
  const mount = document.getElementById("app");
  const parts = (mount.dataset.partials || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  for (const name of parts) {
    try {
      const r = await fetch(name);   // relative — works on the server and on static hosts
      if (r.ok) mount.insertAdjacentHTML("beforeend", await r.text());
    } catch { /* optional partial unavailable (e.g. dev.html on a static host) — skip */ }
  }
  const s = document.createElement("script");
  s.src = "app.js";
  document.body.appendChild(s);
})();
