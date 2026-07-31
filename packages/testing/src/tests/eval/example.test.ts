import { describe, it, expect } from "vitest";
import { example } from "../../eval/fixtures.js";
import { userText } from "@behalf-js/core";
import type { Profile } from "@behalf-js/core";

interface World {
  hits: string[];
}

describe("example", () => {
  it("shapes name + { world, fixtures, input } into an Example, unchanged", () => {
    const world = (): World => ({ hits: [] });
    const fixtures = (_w: World, _p: Profile) => {
      void _w;
      void _p;
      return { bindings: [] };
    };
    const input = userText("find x");

    const row = example("a search", { world, fixtures, input });

    expect(row.name).toBe("a search");
    expect(row.world).toBe(world);
    expect(row.fixtures).toBe(fixtures);
    expect(row.input).toBe(input);
  });

  it("does no validation or transformation beyond shaping the object", () => {
    const row = example<World>("row", {
      world: () => ({ hits: [] }),
      fixtures: () => ({ bindings: [] }),
      input: userText("hello"),
    });
    expect(Object.keys(row).sort()).toEqual(["fixtures", "input", "name", "world"]);
  });

  it("world() called later still produces independent state per call", () => {
    const row = example<World>("row", {
      world: () => ({ hits: [] }),
      fixtures: () => ({ bindings: [] }),
      input: userText("hello"),
    });
    const w1 = row.world();
    const w2 = row.world();
    w1.hits.push("a");
    expect(w2.hits).toEqual([]);
  });
});
