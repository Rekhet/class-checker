"use strict";
// Mount the HTML partials listed in #app[data-partials] (comma-separated, in order),
// then load app.js. A missing/optional partial (e.g. the dev panels in production)
// is skipped silently; app.js guards any nodes that didn't get mounted.
(async () => {
  const mount = document.getElementById("app");
  const parts = (mount.dataset.partials || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  // "no-cache" revalidates instead of re-downloading: GitHub Pages answers an
  // unchanged file with 304 (ETag), so a redeploy is picked up immediately and
  // a repeat visit costs a round trip per file rather than its body. All
  // requests go out together; the partials are still mounted in listed order.
  const get = (url) => fetch(url, { cache: "no-cache" })
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null);   // optional partial unavailable (e.g. dev.html on a static host)
  const [app, ...html] = await Promise.all([get("app.js"), ...parts.map(get)]);
  for (const h of html) if (h != null) mount.insertAdjacentHTML("beforeend", h);
  const s = document.createElement("script");
  if (app != null) s.textContent = app + "\n//# sourceURL=app.js";
  else s.src = "app.js?v=" + Date.now();   // fetch failed: let the browser try itself
  document.body.appendChild(s);
})();
