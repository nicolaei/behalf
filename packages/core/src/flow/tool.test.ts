// Story 1 — Tool carries a schema.
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "./tool.js";

describe("tool() schema", () => {
  it("defaults to a permissive schema when none is given", () => {
    const search = tool<{ query: string }, { hits: string[] }>("search", "Search the web.");

    expect(search.schema).toBeDefined();
    // Permissive: parses an arbitrary object without throwing.
    expect(() => search.schema.parse({ anything: 1 })).not.toThrow();
  });

  it("keeps the schema passed in", () => {
    const inputSchema = z.object({ query: z.string() });
    const search = tool<{ query: string }, { hits: string[] }>(
      "search",
      "Search the web.",
      inputSchema,
    );

    expect(search.schema).toBe(inputSchema);
    expect(() => search.schema.parse({ query: "hello" })).not.toThrow();
    expect(() => search.schema.parse({ query: 1 })).toThrow();
  });
});
