"use strict";
// Public frontend config. SAFE TO COMMIT/SHIP — the OAuth *client_id* is public
// by design (it is sent to the browser anyway). NEVER put the client *secret*
// (google_oauth_secret.json) here or anywhere client-side.
//
// Set this for production so Google Calendar export works without a prompt:
//   window.GOOGLE_CLIENT_ID = "1234567890-abc.apps.googleusercontent.com";
// Leave empty for local/dev — app.js then prompts once and remembers it.
window.GOOGLE_CLIENT_ID = "1357339441-37gp3tq7v7bajmldkicteajonpe6jpk0.apps.googleusercontent.com";

// Default search scope on load. Empty string = 전체 All (no default).
//   year: "2026"  (any year present in the data)
//   term: "1학기" | "2학기" | "여름학기" | "겨울학기"  (or spring/fall/summer/winter,
//         or the raw 20-char term code). Applied only if that option exists.
window.SEARCH_DEFAULT_YEAR = "2026";
window.SEARCH_DEFAULT_TERM = "fall";

// Default calendar (.ics) export range. "YYYY-MM-DD" each; empty = today / +16 weeks.
window.ICS_DEFAULT_START = "2026-09-01";
window.ICS_DEFAULT_END = "2026-12-21";
