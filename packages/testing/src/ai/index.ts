// The "./ai" subpath: test helpers that only make sense once the ai()
// extension is registered — model fakes today, thread-history assertions as
// they arrive. The root subpath is the pure engine stepping vocabulary and
// never imports from here (enforced by a lint rule in eslint.config.js).

export { fakePort } from "./fake-port.js";
