import { describe, it, expect } from "vitest";
import { findTopLevelFences } from "./markdown-fences.js";

describe("findTopLevelFences", () => {
  it("finds a single top-level fence with its language, info, and content", () => {
    const markdown = ["```ts source=a/b.ts#setup", "const x = 1;", "```"].join("\n");

    expect(findTopLevelFences(markdown)).toEqual([
      { fenceLength: 3, lang: "ts", info: "source=a/b.ts#setup", content: "const x = 1;" },
    ]);
  });

  it("finds a fence with no info string", () => {
    const markdown = ["```mermaid", "flowchart TB", "```"].join("\n");

    expect(findTopLevelFences(markdown)).toEqual([
      { fenceLength: 3, lang: "mermaid", info: "", content: "flowchart TB" },
    ]);
  });

  it("finds every top-level fence in a doc with several", () => {
    const markdown = [
      "```ts source=a.ts",
      "one",
      "```",
      "",
      "prose in between",
      "",
      "```ts source=b.ts",
      "two",
      "```",
    ].join("\n");

    expect(findTopLevelFences(markdown)).toEqual([
      { fenceLength: 3, lang: "ts", info: "source=a.ts", content: "one" },
      { fenceLength: 3, lang: "ts", info: "source=b.ts", content: "two" },
    ]);
  });

  it("does not surface a fence nested inside an outer, higher-backtick-count fence", () => {
    // The standard CommonMark technique for showing a literal fence as text:
    // an outer fence with more backticks than anything inside it. The inner
    // "```ts source=...` sequence is opaque content of the outer block, not
    // a fence of its own — this is what makes an illustrative example in a
    // doc invisible to a sync-check scanner, with no escape character.
    const markdown = [
      "````markdown",
      "```ts source=docs/examples/hello-world/basic.ts#setup",
      "export const x = 1;",
      "```",
      "````",
    ].join("\n");

    expect(findTopLevelFences(markdown)).toEqual([
      {
        fenceLength: 4,
        lang: "markdown",
        info: "",
        content: [
          "```ts source=docs/examples/hello-world/basic.ts#setup",
          "export const x = 1;",
          "```",
        ].join("\n"),
      },
    ]);
  });

  it("requires the closing fence to have at least as many backticks as the opening one", () => {
    // A 3-backtick line inside a 4-backtick-opened fence can't close it —
    // this is the same rule that makes the nesting case above safe.
    const markdown = ["````markdown", "```", "content still inside", "````"].join("\n");

    expect(findTopLevelFences(markdown)).toEqual([
      {
        fenceLength: 4,
        lang: "markdown",
        info: "",
        content: ["```", "content still inside"].join("\n"),
      },
    ]);
  });

  it("does not treat a fence with an info string as a valid close", () => {
    // A closing fence must be bare backticks only, per CommonMark — a line
    // with a language/info string after the backticks is still content.
    const markdown = ["```ts", "one", "``` not a close", "real content", "```"].join("\n");

    expect(findTopLevelFences(markdown)).toEqual([
      {
        fenceLength: 3,
        lang: "ts",
        info: "",
        content: ["one", "``` not a close", "real content"].join("\n"),
      },
    ]);
  });
});
