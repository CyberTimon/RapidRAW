// @tauri-apps/plugin-http: the browser's own fetch. In the desktop app, requests go out from Rust without CORS; from
// a browser they are subject to CORS, so services that only allow the desktop app (e.g. RapidRAW's cloud sign-in)
// fail, and RapidRAW shows them as unavailable.
export const fetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);
