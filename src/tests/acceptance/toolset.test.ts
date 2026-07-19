import { describe, it, expect } from "vitest";
import { toolset, expand, satisfiesPersonas } from "../../index.js";
import type { Model, Profile } from "../../index.js";

// Every scenario here needs toolset()/expand() to be real — they're currently
// bare `declare function` stubs with no implementation body. Written now so
// the shape is pinned down before that slice starts.
describe("toolset groups multiple tool handlers behind one binding", () => {
  it("resolves the toolset's individual handlers by name via discover()", async () => {
    const bundle = toolset("search-bundle", "Search-related tools.");
    const binding = expand(bundle, () =>
      Promise.resolve({ search: (input: unknown) => Promise.resolve({ hits: [input] }) }),
    );

    if (binding.kind !== "toolset") throw new Error("expected a toolset binding");
    const handlers = await binding.discover();
    const search = handlers["search"];
    if (!search) throw new Error("expected a 'search' handler from discover()");

    const result = await search("x", {
      thread: "thread-1" as never,
      stream: { delta: () => undefined },
      runFlow: () => Promise.resolve(undefined),
    });

    expect(result).toEqual({ hits: ["x"] });
  });

  it("a persona referencing a toolset is fully satisfied once the toolset is expanded", () => {
    const model: Model = {
      identifier: "gpt",
      provider: "test",
      contextWindow: 1000,
      reasoning: ["medium"],
    };
    const bundle = toolset("search-bundle", "Search-related tools.");
    const profile: Profile = { model, system: "test", tools: [bundle], reasoning: "medium" };
    const binding = expand(bundle, () => Promise.resolve({}));

    const missing = satisfiesPersonas(
      [profile],
      () => ({ model, respond: () => Promise.reject(new Error("unused")) }),
      [binding],
    );

    // then the toolset binding alone satisfies the persona's tool requirement —
    // no need to call discover() up front to know it's covered
    expect(missing).toEqual([]);
  });
});
