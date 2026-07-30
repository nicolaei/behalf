// Node ids come from a single, process-global, never-reset counter
// (flow/graph.ts's nodeIdSequence) — deliberately, so a use()-embedded
// subgraph's own ids never collide with its enclosing graph's, an
// invariant replayPosition's own depth-search relies on (see the counter's
// own doc comment). The cost: calling the exact same graph-building
// function twice — once per process, e.g. once at session creation and
// again at every later reattachment — assigns entirely different numbers
// to structurally identical nodes, since the counter has no notion of
// "I've built this shape before." Confirmed live: this is the root cause
// behind two separate real bugs (replaying an aborted turn, and — still
// open — a multi-turn conversation getting stuck inside a used subgraph)
// after a real container restart.
//
// This file doesn't pin a specific fix (e.g. a depth-aware per-outermost-
// build reset) — it pins the observable contract any fix must satisfy:
// building the same shape twice, in what stands in for two different
// processes, must assign identical ids to identical nodes, including
// nested ones, and regardless of what else got built first in between.

import { describe, it, expect } from "vitest";
import { defineGraph, agentTurn, userInput } from "../../index.js";
import type { Handle, Profile } from "../../index.js";

function testProfile(): Profile {
  return {
    model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
    system: "test",
    tools: [],
  };
}

/** The exact chatGraph shape (outer wait/use pair) — capturing the Handles
 * a test needs to compare, the same way chatGraph itself never does
 * (nothing outside this file needs to inspect raw ids). */
function buildChatLikeGraph(): { turn: Handle; waitForPrompt: Handle } {
  let turn!: Handle;
  let waitForPrompt!: Handle;
  defineGraph("chat-like", (flow) => {
    turn = flow.use(agentTurn(testProfile()));
    waitForPrompt = flow.waitFor({ kind: "chat", match: () => undefined } as never);
    flow.entry(waitForPrompt);
    turn.then(waitForPrompt);
    waitForPrompt.then(turn);
  });
  return { turn, waitForPrompt };
}

describe("node id determinism across separate builds of the same graph shape", () => {
  it("building the same graph shape twice assigns identical ids to identical outer nodes", () => {
    const first = buildChatLikeGraph();
    const second = buildChatLikeGraph();
    expect(second.waitForPrompt.id).toBe(first.waitForPrompt.id);
    expect(second.turn.id).toBe(first.turn.id);
  });

  it("still holds when something else builds nodes first, in between", () => {
    const first = buildChatLikeGraph();
    buildChatLikeGraph(); // an unrelated build in between, consumes ids — must not perturb the next one
    const third = buildChatLikeGraph();
    expect(third.waitForPrompt.id).toBe(first.waitForPrompt.id);
    expect(third.turn.id).toBe(first.turn.id);
  });

  it("the nested subgraph's own inner nodes match too, not just the outer ones", () => {
    // agentTurn(profile) builds its own subgraph as a side effect of
    // flow.use() — its Graph object is reachable off the outer graph's own
    // "turn" node (a use-kind NodeKind carries `subgraph: Graph`).
    function innerNodeIds(turn: Handle, outerGraph: ReturnType<typeof defineGraph>): string[] {
      const node = outerGraph.nodes.get(turn.id);
      if (node?.kind !== "use") throw new Error("expected turn to be a use node");
      return [...node.subgraph.nodes.keys()];
    }

    let firstGraph!: ReturnType<typeof defineGraph>;
    let firstTurn!: Handle;
    firstGraph = defineGraph("chat-like", (flow) => {
      firstTurn = flow.use(agentTurn(testProfile()));
      const waitForPrompt = flow.waitFor(userInput("chat"));
      flow.entry(waitForPrompt);
      firstTurn.then(waitForPrompt);
      waitForPrompt.then(firstTurn);
    });

    let secondGraph!: ReturnType<typeof defineGraph>;
    let secondTurn!: Handle;
    secondGraph = defineGraph("chat-like", (flow) => {
      secondTurn = flow.use(agentTurn(testProfile()));
      const waitForPrompt = flow.waitFor(userInput("chat"));
      flow.entry(waitForPrompt);
      secondTurn.then(waitForPrompt);
      waitForPrompt.then(secondTurn);
    });

    expect(innerNodeIds(secondTurn, secondGraph)).toEqual(innerNodeIds(firstTurn, firstGraph));
  });
});
