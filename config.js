"use strict";
// Public frontend config. SAFE TO COMMIT/SHIP — the OAuth *client_id* is public
// by design (it is sent to the browser anyway). NEVER put the client *secret*
// (google_oauth_secret.json) here or anywhere client-side.
//
// Set this for production so Google Calendar export works without a prompt:
//   window.GOOGLE_CLIENT_ID = "1234567890-abc.apps.googleusercontent.com";
// Leave empty for local/dev — app.js then prompts once and remembers it.
window.GOOGLE_CLIENT_ID = "1357339441-37gp3tq7v7bajmldkicteajonpe6jpk0.apps.googleusercontent.com";
