// The Learn "Reporting state" page's example: a small approval flow whose
// three nodes each declare an application-level `state` — "red" while a
// request is pending, "yellow" while it waits for approval, "green" once
// it's done. Driven in traffic-light.test.ts, which submits the approval
// message and asserts the resulting stateChange events.

import { defineGraph, outputs, userInput } from "@behalf-js/core";
import type { Graph } from "@behalf-js/core";

// #region graph
export const trafficLight: Graph = defineGraph("traffic-light", (flow) => {
  // #region nodes
  const request = flow.step(
    outputs(() => "requested"),
    { label: "request", state: "red" },
  );
  const wait = flow.waitFor(userInput("approval"), { label: "await-approval", state: "yellow" });
  const done = flow.step(
    outputs(() => "done"),
    { label: "mark-done", state: "green" },
  );
  // #endregion nodes

  flow.entry(request);
  request.then(wait);
  wait.then(done);
  done.then(flow.finish);
});
// #endregion graph
