import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineGraph, runtime, runFlow, userText } from "@behalf-js/core";
import type { Envelope, EventType } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import {
  searchFiles,
  searchFilesBinding,
  progressDemo,
  progressDemoBinding,
} from "./search-files.js";

function neverCalled(): never {
  throw new Error("no model call expected in this test");
}

type CommittedEnvelope = Extract<Envelope, { type: EventType }>;

function isCommitted(envelope: Envelope): envelope is CommittedEnvelope {
  return envelope.form === "committed";
}

describe("search_files streams progress while it works", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "search-files-"));
    await writeFile(path.join(dir, "a.txt"), "needle here\nnothing\n");
    await writeFile(path.join(dir, "b.txt"), "nothing at all\n");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("broadcasts a delta per scanned file before its own stream commits", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [searchFilesBinding], store });
    const graph = defineGraph("search", (flow) => {
      const step = flow.step(async (context) =>
        context.output(await context.callTool(searchFiles, { path: dir, query: "needle" })),
      );
      flow.entry(step);
      step.then(flow.finish);
    });

    const forms: string[] = [];
    const deltas: string[] = [];
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    void (async () => {
      for await (const envelope of store.changes()) {
        forms.push(envelope.form);
        if (envelope.form === "delta" && "text" in envelope.delta) deltas.push(envelope.delta.text);
        // stop at the first committed envelope after both deltas have
        // landed: that's the tool's own stream commit
        if (envelope.form === "committed" && deltas.length === 2) {
          resolveDone?.();
          return;
        }
      }
    })();

    await Promise.all([done, runFlow(graph, userText("go"), ready)]);

    // both files got their own delta, scanned before the result committed
    expect(deltas).toHaveLength(2);
    expect(deltas[1]).toBe("scanned 2/2 files (1 hits so far)");

    const committed = store.events().filter(isCommitted);
    expect(committed.map((envelope) => envelope.type)).toEqual(["input", "output", "output"]);
    const [, streamed] = committed;
    expect(streamed?.event).toEqual({
      value: { matches: [{ file: path.join(dir, "a.txt"), line: 1 }] },
    });

    // the deltas were observed strictly before the stream's own commit
    const firstCommittedIndex = forms.indexOf("committed", 1);
    const lastDeltaIndex = forms.lastIndexOf("delta");
    expect(lastDeltaIndex).toBeLessThan(firstCommittedIndex);
  });
});

describe("the delta/commit/abort lifecycle", () => {
  it("commits normally when the tool succeeds", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [progressDemoBinding], store });
    const graph = defineGraph("progress-succeed", (flow) => {
      const step = flow.step(async (context) =>
        context.output(await context.callTool(progressDemo, { succeed: true })),
      );
      flow.entry(step);
      step.then(flow.finish);
    });

    await runFlow(graph, userText("go"), ready);

    const streamed = store
      .events()
      .filter(isCommitted)
      .find((envelope) => envelope.type === "output");
    expect(streamed?.event).toEqual({ value: { done: true } });
    expect(streamed?.aborted).toBeUndefined();
  });

  it("marks the envelope aborted when the tool aborts instead of committing", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [progressDemoBinding], store });
    const graph = defineGraph("progress-abort", (flow) => {
      const step = flow.step(async (context) =>
        context.output(await context.callTool(progressDemo, { succeed: false })),
      );
      flow.entry(step);
      step.then(flow.finish);
    });

    await runFlow(graph, userText("go"), ready);

    const aborted = store
      .events()
      .filter(isCommitted)
      .filter((envelope) => envelope.type === "output")
      .find((envelope) => envelope.aborted);
    expect(aborted).toBeDefined();
    expect(aborted?.aborted).toBe(true);
  });
});
