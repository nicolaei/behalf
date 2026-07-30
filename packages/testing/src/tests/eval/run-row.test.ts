import { describe, it, expect } from "vitest";
import { provide, tool, userText } from "@behalf-js/core";
import type { ModelPort, Profile, AssistantMessage } from "@behalf-js/core";
import { runRow } from "../../eval/harness/run-row.js";
import { example } from "../../eval/fixtures.js";

function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "text", text }],
    usage: { input: 1, output: 1 },
  };
}

function assistantToolCall(name: string, input: unknown): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "toolCall", correlationId: "1", name, input }],
    usage: { input: 1, output: 1 },
  };
}

const search = tool<{ query: string }, { hits: string[] }>("search", "Searches for a query.");

function scriptedPort(reply: () => AssistantMessage): ModelPort {
  return {
    model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
    respond: () => Promise.resolve(reply()),
  };
}

interface World {
  hits: string[];
}

function tinyProfile(model: ModelPort["model"]): Profile {
  return { model, system: "agent", tools: [search] };
}

describe("runRow", () => {
  it("drives the profile through a full turn and returns a folded Run", async () => {
    const port = scriptedPort(() => assistantText("done"));
    const row = example<World>("row", {
      world: () => ({ hits: [] }),
      fixtures: () => ({ models: port, bindings: [] }),
      input: userText("hello"),
    });

    const run = await runRow(tinyProfile(port.model), row, "test");

    expect(run.world).toEqual({ hits: [] });
    expect(run.tools).toEqual([]);
  });

  it("drives a tool call through to the tool binding and folds it into the Run", async () => {
    let calls = 0;
    const port = scriptedPort(() => {
      calls += 1;
      return calls === 1 ? assistantToolCall("search", { query: "x" }) : assistantText("done");
    });
    const row = example<World>("row", {
      world: () => ({ hits: [] }),
      fixtures: (world) => ({
        models: port,
        bindings: [
          provide(search, (input: { query: string }) => {
            world.hits.push(input.query);
            return Promise.resolve({ hits: ["a"] });
          }),
        ],
      }),
      input: userText("find x"),
    });

    const run = await runRow(tinyProfile(port.model), row, "test");

    expect(run.world.hits).toEqual(["x"]);
    expect(run.tools).toHaveLength(1);
    expect(run.tools[0]).toMatchObject({ name: "search", input: { query: "x" } });
  });

  it("two calls with the same row never share world state", async () => {
    const port = scriptedPort(() => assistantText("done"));
    const row = example<World>("row", {
      world: () => ({ hits: [] }),
      fixtures: () => ({ models: port, bindings: [] }),
      input: userText("hello"),
    });

    const first = await runRow<World, unknown>(tinyProfile(port.model), row, "test");
    (first.world as World).hits.push("mutated");
    const second = await runRow<World, unknown>(tinyProfile(port.model), row, "test");

    expect(second.world).toEqual({ hits: [] });
  });

  it("throws a clear error when fixtures() omits models", async () => {
    const row = example<World>("row", {
      world: () => ({ hits: [] }),
      // `models` is intentionally optional on Fixtures at the type level;
      // the missing-model case is a runtime error, not a compile error.
      fixtures: () => ({ bindings: [] }),
      input: userText("hello"),
    });

    await expect(runRow(tinyProfile({ identifier: "x", provider: "test", contextWindow: 1, reasoning: [] }), row, "myCaller")).rejects.toThrow(
      /myCaller/,
    );
  });

  it("passes the resolved profile into fixtures(), letting a row pick its fake model by identifier", async () => {
    const goodPort = scriptedPort(() => assistantText("good reply"));
    let seenIdentifier: string | undefined;
    const row = example<World>("row", {
      world: () => ({ hits: [] }),
      fixtures: (_world, profile) => {
        seenIdentifier = profile.model.identifier;
        return { models: goodPort, bindings: [] };
      },
      input: userText("hello"),
    });

    await runRow(tinyProfile(goodPort.model), row, "test");

    expect(seenIdentifier).toBe("scripted");
  });
});
