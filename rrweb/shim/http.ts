// @tauri-apps/plugin-http: the browser's own fetch. In the desktop app, requests go out from Rust without CORS; from
// a browser they are subject to CORS, so services that only allow the desktop app (e.g. RapidRAW's cloud sign-in,
// whose requests carry headers the browser has to ask permission for) fail, and RapidRAW shows them as unavailable.
// Taken when the module loads: tauri-plugin-clerk replaces globalThis.fetch with a wrapper that sends its own requests
// back here, so calling globalThis.fetch would recurse until the stack overflows.
const browserFetch = globalThis.fetch.bind(globalThis);
export const fetch: typeof globalThis.fetch = (input, init) => browserFetch(input, init);
