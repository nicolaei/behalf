// graphToMermaid — renders a real Graph as Mermaid flowchart syntax, so a
// diagram can be generated from (and kept honest against) the graph it
// depicts, instead of hand-drawn and free to drift.
import { describe, it, expect } from "vitest";
import { defineGraph } from "../packages/core/src/flow/graph.js";
import type { Graph, NodeId, NodeKind } from "../packages/core/src/flow/graph.js";
import { userInput } from "../packages/core/src/flow/waitable.js";
import { join } from "../packages/core/src/flow/step.js";
import type { StepContext } from "../packages/core/src/flow/step.js";
import type { Profile } from "../packages/core/src/flow/profile.js";
import { graphToMermaid } from "./graph-to-mermaid.js";

/** Finds the one node of `kind` a test graph is known to have, or fails loudly. */
function nodeIdOf(graph: Graph, kind: NodeKind["kind"]): NodeId {
  for (const [id, node] of graph.nodes) if (node.kind === kind) return id;
  throw new Error(`no "${kind}" node in graph "${graph.name}"`);
}

describe("graphToMermaid", () => {
  it("starts with a flowchart declaration", () => {
    const graph = defineGraph("g", (flow) => {
      const s = flow.step((c) => Promise.resolve(c.output(1)));
      flow.entry(s);
      s.then(flow.finish);
    });

    expect(graphToMermaid(graph)).toMatch(/^flowchart /);
  });

  it("renders the finish node as a terminal (circle) shape", () => {
    const graph = defineGraph("g", (flow) => {
      const s = flow.step((c) => Promise.resolve(c.output(1)));
      flow.entry(s);
      s.then(flow.finish);
    });

    const finishId = nodeIdOf(graph, "finish");
    expect(graphToMermaid(graph)).toContain(`${finishId}(("finish"))`);
  });

  it("renders a plain step's label option, in a rectangle shape", () => {
    const graph = defineGraph("g", (flow) => {
      const s = flow.step((c) => Promise.resolve(c.output(1)), { label: "classify" });
      flow.entry(s);
      s.then(flow.finish);
    });

    expect(graphToMermaid(graph)).toContain('["classify"]');
  });

  it("falls back to the node id when a plain step has no label", () => {
    const graph = defineGraph("g", (flow) => {
      const s = flow.step((c) => Promise.resolve(c.output(1)));
      flow.entry(s);
      s.then(flow.finish);
    });

    const stepId = nodeIdOf(graph, "step");
    expect(graphToMermaid(graph)).toContain(`${stepId}["${stepId}"]`);
  });

  it("renders an unconditional `then` edge with no label", () => {
    const graph = defineGraph("g", (flow) => {
      const s = flow.step((c) => Promise.resolve(c.output(1)));
      flow.entry(s);
      s.then(flow.finish);
    });

    const stepId = nodeIdOf(graph, "step");
    const finishId = nodeIdOf(graph, "finish");
    expect(graphToMermaid(graph)).toContain(`${stepId} --> ${finishId}`);
  });

  it("labels a `then` edge with a non-default threadAction", () => {
    const graph = defineGraph("g", (flow) => {
      const s = flow.step((c) => Promise.resolve(c.output(1)));
      flow.entry(s);
      s.then(flow.finish, { threadAction: "fork" });
    });

    expect(graphToMermaid(graph)).toContain('-->|"then (fork)"|');
  });

  it("uses a custom edge label when given, instead of the generic kind name", () => {
    const graph = defineGraph("g", (flow) => {
      const s = flow.step((c) => Promise.resolve(c.output(1)));
      flow.entry(s);
      s.then(flow.finish, { label: "loop back" });
    });

    const mermaid = graphToMermaid(graph);
    expect(mermaid).toContain('-->|"loop back"|');
    expect(mermaid).not.toContain("then");
  });

  it("renders `when`/`otherwise` edges labeled with their kind", () => {
    const graph = defineGraph("g", (flow) => {
      const s = flow.step((c) => Promise.resolve(c.output(true)));
      flow.entry(s);
      s.when((output) => output === true, flow.finish);
      s.otherwise(flow.finish);
    });

    const mermaid = graphToMermaid(graph);
    expect(mermaid).toContain('-->|"when"|');
    expect(mermaid).toContain('-->|"otherwise"|');
  });

  it("renders every fan-out edge from a `then([...])` array", () => {
    let startId = "";
    let aId = "";
    let bId = "";
    const graph = defineGraph("g", (flow) => {
      const a = flow.step((c) => Promise.resolve(c.output(1)));
      const b = flow.step((c) => Promise.resolve(c.output(2)));
      const start = flow.step((c) => Promise.resolve(c.output(0)));
      startId = start.id;
      aId = a.id;
      bId = b.id;
      flow.entry(start);
      start.then([a, b]);
      a.then(flow.finish);
      b.then(flow.finish);
    });

    const mermaid = graphToMermaid(graph);
    expect(mermaid).toContain(`${startId} --> ${aId}`);
    expect(mermaid).toContain(`${startId} --> ${bId}`);
  });

  it("renders a use() node with its subgraph's name", () => {
    const sub = defineGraph("sub-flow", (flow) => {
      const s = flow.step((c) => Promise.resolve(c.output(1)));
      flow.entry(s);
      s.then(flow.finish);
    });
    const graph = defineGraph("outer", (flow) => {
      const u = flow.use(sub);
      flow.entry(u);
      u.then(flow.finish);
    });

    expect(graphToMermaid(graph)).toContain('"use: sub-flow"');
  });

  it("renders a waitFor node with its Waitable's label", () => {
    const graph = defineGraph("g", (flow) => {
      const w = flow.waitFor(userInput("follow-up"));
      flow.entry(w);
      w.then(flow.finish);
    });

    expect(graphToMermaid(graph)).toContain('"waitFor: follow-up"');
  });

  it("renders an interrupt node distinctly from a waitFor node", () => {
    const graph = defineGraph("g", (flow) => {
      const i = flow.interrupt(userInput("abort"), (c) => Promise.resolve(c.output(1)));
      flow.entry(i);
      i.then(flow.finish);
    });

    const mermaid = graphToMermaid(graph);
    expect(mermaid).toContain('"interrupt: abort"');
    expect(mermaid).not.toContain('"waitFor: abort"');
  });

  it("renders a forEach node as its own dynamic fan-out shape", () => {
    const branch = (item: unknown) =>
      defineGraph("branch", (flow) => {
        const s = flow.step((c) => Promise.resolve(c.output(item)));
        flow.entry(s);
        s.then(flow.finish);
      });
    const graph = defineGraph("g", (flow) => {
      const f = flow.forEach((output) => output as unknown[], branch);
      flow.entry(f);
      f.then(flow.finish);
    });

    expect(graphToMermaid(graph)).toContain('"forEach"');
  });

  it("renders a join()-tagged step in a shape distinct from a plain step", () => {
    const graph = defineGraph("g", (flow) => {
      const merge = flow.step(join((c) => c.inputs));
      flow.entry(merge);
      merge.then(flow.finish);
    });

    const stepId = nodeIdOf(graph, "step");
    expect(graphToMermaid(graph)).toContain(`${stepId}{{`);
  });

  it("renders a persona-carrying step in a shape distinct from a plain step", () => {
    const persona: Profile = {
      model: { identifier: "m", provider: "p", contextWindow: 1000, reasoning: [] },
      system: "You are a test persona.",
      tools: [],
    };
    const modelStep = Object.assign(
      (c: StepContext) => c.modelCall(persona).then((result) => c.output(result)),
      { persona },
    );
    const graph = defineGraph("g", (flow) => {
      const s = flow.step(modelStep);
      flow.entry(s);
      s.then(flow.finish);
    });

    const stepId = nodeIdOf(graph, "step");
    expect(graphToMermaid(graph)).toContain(`${stepId}("${stepId}")`);
  });
});
