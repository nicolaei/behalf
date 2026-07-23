# Documentation style guide

Rules for writing behalf's docs. This governs everything under `docs/` except
`reference.md`, which predates it and already follows a compatible but denser
convention (see [Where this doesn't apply](#where-this-doesnt-apply)).

## The four quadrants

Docs split into four kinds of writing, each with a different job. Confusing
them is the most common way documentation fails.

| Quadrant | Question it answers | Where it lives here |
| --- | --- | --- |
| **Tutorial** | "Walk me through it" | `docs/learn/` — a linear path, one worked example, builds confidence |
| **How-to guide** | "How do I do X?" | `docs/learn/` — a recipe for a specific task; a verb-phrase slug (`add-a-tool.md`) tells it apart from a concept page |
| **Explanation** | "Why does it work like that?" | `docs/learn/` (concept pages) — mental models, design rationale |
| **Reference** | "What are the exact parameters?" | `docs/reference.md` — dense, precise, no persuasion |

`docs/reference.md` already nails the reference quadrant: it's information-
dense, assumes the reader knows what they're looking for, and never explains
*why* — it states. **Don't make `docs/learn/` do that job too.** A learn page
teaches one idea at a time and is allowed to be slower than reference.

A rule of thumb when starting a new page: if you'd cite it while debugging at
2am, it's reference. If you'd read it once to build a mental model, it's a
concept page. If someone forwards it to a teammate with "just follow these
steps," it's a guide — both live under `docs/learn/`, told apart by slug.

## Page anatomy

Every `docs/learn/` page follows this shape (react.dev/learn's template,
adapted to plain Markdown — we have no MDX components, so callouts are GitHub
alert blockquotes and "Sandpack" becomes a linked, runnable example file).

```markdown
# Page title

One to three sentences: what this page covers and why it matters. Not a
repeat of the title — answer "why should I keep reading."

## You will learn

- A concrete thing you'll be able to do or explain after this page
- Another one
- (4-6 bullets, deliverables not topics — "how to X," not "X")

## First section — usually the "why," a problem worth solving

Prose that sets up the problem. If it helps, show the naive/wrong approach
first (see [Before/after comparisons](#beforeafter-comparisons)).

## Later sections — the "how"

Prose plus example references (see [Example files](#example-files-typechecked-and-tested)).
Break up dense reasoning with a callout when you hit a gotcha or a
worth-knowing-but-not-essential aside.

## Recap

- Bullet summary, 3-8 items, one line each
- What to reach for next: link to the following page or a relevant guide
```

Section headings are imperative ("Adding a tool") or plain noun phrases
("Threads and forking"), rarely questions — reserve a question heading for
the one spot per page where you're pre-empting a specific reader doubt
("Why not just use a queue?").

## Callouts

Plain Markdown, rendered natively by GitHub — no plugin needed.

```markdown
> [!NOTE]
> A short aside — a convention, a scope clarification. 1-3 sentences.

> [!WARNING]
> A pitfall: a mistake the reader is likely to make and its consequence.

> [!TIP]
> An optional shortcut or idiom — skippable, not required to follow the page.
```

For a deep dive (an optional, longer digression into "how this works under
the hood"), use a collapsible `<details>` block — GitHub renders these
natively too, and collapsed-by-default keeps the page skimmable:

```markdown
<details>
<summary>Deep dive: how compaction picks its cut point</summary>

200-400 words. Fine to include its own example reference.

</details>
```

Budget roughly one callout per 400-500 words of prose — enough to break up
density, not so many the page feels like a warning label.

## Voice and grammar

Distilled from react.dev/learn, which is the reference for "simple to follow,
still precise."

1. **Active voice.** "The engine folds the log" not "the log is folded by the
   engine." Passive voice is the default failure mode to watch for in review.
2. **Second person, direct.** "You wire a `ToolHandler` to a `tool`," not "one
   wires..." or "developers wire...".
3. **Define a term at first use, then never redefine it.** If `docs/reference.md`
   already has the authoritative definition, link it once and reuse the exact
   word afterward — don't invent a synonym for variety. (`Profile`, `Emit`,
   `ThreadAction`, `Waitable` are locked terms — see reference.md's Terms
   section and Interfaces.)
4. **Short sentences carry the weight; long ones explain the exception.**
   Aim for ~12-20 words in a load-bearing sentence. It's fine to go longer
   when you're spelling out a subtlety, but don't do it twice in a row.
5. **Always introduce a code reference with a sentence stating what it shows.**
   Never drop a snippet cold. "Here's a step that reads the thread instead of
   the previous output:" then the reference — not the reverse.
6. **After the snippet, one or two sentences of observation, not a walkthrough.**
   Point at the one thing that matters ("Notice `context.inputs[0]`, not
   `context.thread.messages` — this step reads the previous result, not the
   conversation"). Never narrate line-by-line.
7. **Name the wrong way before the right way, and label both.** Introduce an
   anti-pattern with something like "You might reach for a `waitFor` here —"
   then show why it doesn't fit, then the fix. Use `❌`/`✅` (or "Avoid"/
   "Prefer") consistently across all pages, never invent alternate labels.
8. **Correct a likely misconception gently.** "You might expect X — but Y,
   because Z" beats "Note that X is wrong." Validate the instinct, then
   correct it, then say why.
9. **Contractions are fine and preferred.** "Doesn't," "won't," "it's" — this
   is conversational technical writing, not a spec.
10. **One analogy per concept, used consistently.** The graph/mermaid diagrams
    in reference.md already carry the structural analogies (kitchen-order-style
    sequencing isn't ours — a session's log/inbox model is closer to an
    append-only ledger with a pending tray). Pick the metaphor once per
    concept and don't mix it with a second one on the same page.
11. **No filler headers.** Don't write "Introduction" or "Overview" — the
    page's own intro paragraph is the introduction.
12. **Never name a specific provider when explaining *why*.** `ModelPort` is
    the provider-agnostic seam — reasoning written against one provider's
    quirk ("Anthropic encrypts thinking into signature") reads like it's
    describing the library's design instead of one adapter's. Say "some
    providers encrypt the full thinking into an opaque token" or "a port may
    need to convert a block when the thread crosses providers," never the
    provider's name. **Examples are the exception** — a concrete code sample
    naming a real model (`claude-sonnet-5`, `gpt-5.5`) is fine and expected;
    the rule is about explanatory prose, not code.

## Diagrams

Use Mermaid, matching `docs/reference.md`'s existing style — it renders
natively on GitHub, in most editors, and needs no build step. Prefer it over
prose whenever a page is describing:

- a *shape* (graph, tree, pipeline) — `flowchart LR`/`TB`
- a *sequence over time* (a turn, a request/response, a stream opening and
  closing) — `sequenceDiagram`
- *state* changing (cursor status, thread lifecycle) — `stateDiagram-v2`

Conventions (following reference.md):

- Label edges with the verb, not just an arrow: `-->|"drained by engine"|`.
- Group related nodes with `subgraph`.
- One diagram illustrates one idea. If a page needs to show both a shape and
  a sequence, use two small diagrams, not one crowded one.
- A diagram earns its place if it replaces a paragraph of spatial reasoning
  ("A connects to B, which fans out to C and D, which join at E..."). If the
  prose sentence is already short, skip the diagram.

There is no Sandpack/interactive-sandbox equivalent here — the substitute is
a real, runnable example file the reader can open and execute themselves (see
below), linked directly rather than embedded in an iframe.

## Example files: typechecked and tested

Every code block in `docs/learn/` is a **reference into a
real file**, never hand-typed prose-code. This is the mechanism:

### Layout

```text
docs/
  learn/
    README.md              # top-level table of contents
    get-started/
      README.md            # section index — intro + links, no page anatomy
      quick-start.md
      thinking-in-behalf.md
    building-the-graph/
      README.md
      wiring-a-graph.md
      threads-and-forking.md
  examples/
    quick-start/
      basic.ts
    thinking-in-behalf/
      triage.ts
    wiring-a-graph/
      audit.ts
    threads-and-forking/
      fork-and-revert.ts
```

`docs/learn/` is one subfolder per section (kebab-case, matching the section
title); each section has its own `README.md` — a short intro plus a linked
list of its pages, no "You will learn"/Recap since it isn't a page itself.
GitHub renders a folder's `README.md` automatically, so a section is
browsable on its own. Cross-section links use `../other-section/page.md`;
same-section links stay `./page.md`.

`docs/examples/<page-slug>/` stays **flat**, keyed by page slug only — not
nested to match the section folders. A page's section can change without
moving its example.

`docs/examples/<page-slug>/` mirrors the doc that uses it. This is separate
from the top-level `examples/` folder (`simple-chat`, `multi-step-agent`),
which holds full standalone apps with their own `package.json` — those are
"go run this," not "read this fragment." Doc examples are small, focused
files meant to be *read in slices*, not run as programs (though several will
also be exercised end-to-end by an acceptance test — see below).

### How a doc example gets typechecked and tested

`docs/examples/**/*.ts` is added to the root `tsconfig.json`'s `include`. Every
doc example imports the library the way a real consumer would — from the built
package, same as `examples/simple-chat` and `examples/multi-step-agent`:
`import { defineGraph } from "behalf";`, never a relative path into `src/`.

That means `npm run build` must run before a doc example's types are checked
against its current shape — the docs verification script (`npm run
verify:docs`, added alongside the existing `verify`) runs `build` first, so
this is automatic and never a manual step to remember.

Every doc example file has a matching `*.test.ts` (or is covered by one
`docs/examples/**/*.test.ts` runner) so `npm test` actually exercises it — a
snippet that compiles but throws at runtime is still a broken doc.

### Referencing a slice of a file from a code block

Mark the reusable slice in the source file with a named region, using
VS Code's native folding markers (`#region`/`#endregion`) — free editor
folding as a side benefit:

```ts
// docs/examples/hello-world/basic.ts
import { defineGraph, agentTurn, type Profile } from "behalf";

// #region setup
export const assistant: Profile = {
  model: qwen14b,
  system: "You are a helpful assistant.",
  tools: [],
};
// #endregion setup

// #region graph
export const chat = defineGraph("chat", (flow) => {
  const loop = flow.use(agentTurn(assistant));
  flow.entry(loop);
  loop.then(flow.finish);
});
// #endregion graph
```

The doc references it by path and region in the fenced block's info string —
GitHub renders only the language for syntax highlighting and silently drops
the rest, so the reader sees clean, highlighted code with no visible clutter:

```markdown
​```ts source=docs/examples/hello-world/basic.ts#setup
export const assistant: Profile = {
  model: qwen14b,
  system: "You are a helpful assistant.",
  tools: [],
};
​```
```

A `docs-sync` test walks every `.md` file under `docs/`, extracts each
`source=` block, pulls the named region from the real file, and asserts the
two are byte-identical. **This is what "properly tested" means for the docs
themselves**: a doc can't drift from the code it claims to show, and a
mismatch fails CI, not a reader's bug report.

> [!NOTE]
> This uses named regions, not raw line numbers, because line ranges silently
> renumber whenever an unrelated edit lands above them in the file — regions
> can't drift that way, and get free VS Code folding as a bonus. The
> sync-check test's failure message still reports the region's current line
> range, so a reviewer sees exactly which lines changed.

### Full examples

A page section titled "Full example" (or reference.md's "Full examples"
convention) links the whole file rather than a region:

```markdown
​```ts source=docs/examples/threads-and-forking/fork-and-revert.ts
​```
```

### Graph diagrams: generated, side by side

A page showing a graph's *shape* (`wiring-a-graph.md`, `fan-out-and-joining.md`,
`thinking-in-behalf.md`'s "sketch the shape" step) never hand-draws that
diagram — `tools/graph-to-mermaid.ts` generates it from the real `Graph`
object the code above it builds, so the picture can't drift from the wiring
the moment someone changes it. Hand-drawn Mermaid (the "Diagrams" section
above) is still right for a *sequence* or *state* diagram, where there's no
real object to generate from — only for a graph's node/edge shape.

Laid out side by side, code on the left and its diagram on the right —
react.dev's own code-next-to-result rhythm, the closest plain-Markdown
equivalent to a Sandpack embed. GitHub has no native two-column Markdown, so
this uses an HTML `<table>`; the blank line right after every `<td>` and
right before every `</td>` is required — without it, GitHub treats the fence
as raw HTML text instead of a Markdown code block and renders it unstyled:

```markdown
<table>
<tr>
<td>

​```ts source=docs/examples/wiring-a-graph/audit.ts#graph
​```

</td>
<td>

​```mermaid source=docs/examples/wiring-a-graph/audit.ts#audit
​```

</td>
</tr>
</table>
```

The mermaid fence's `source=` works like the code fence's, but names an
**exported binding**, not a region: `#audit` is the `Graph` value
`audit.ts` exports under that name. A `diagram-sync` test (`tools/diagram-sync.ts`,
parallel to the code `docs-sync` test) imports that binding, calls
`graphToMermaid` on it, and asserts the result is byte-identical to the
block's content — the same guarantee the code-region sync gives, extended to
the picture.

## Naming

- Doc file slugs are kebab-case and describe the concept, not the API name
  verbatim: `threads-and-forking.md`, not `threadaction.md`.
- A guide's slug is a verb phrase — `add-a-tool.md`, `stream-tool-progress.md` —
  living in its section folder next to concept pages, not a separate section.
- A section folder is kebab-case, matching its title — `wiring-a-runtime/`,
  not `runtime.md` or `runtime/`.
- An example region name is a short noun phrase scoped to its file, not
  globally unique: `setup`, `graph`, `handler` are fine repeated across files.

## Where this doesn't apply

`docs/reference.md` keeps its existing convention (inline `ts` code blocks,
its own "Full examples" numbered-comment style) — it predates this guide and
rewriting it is out of scope here. New reference material should still follow
its existing internal pattern for consistency, just not this guide's page
anatomy (no "You will learn," no Recap — reference doesn't teach, it states).

## Linting and link-checking

Two checks run over every `.md` file (`docs/` plus the root `README.md`):

- **`npm run lint:md`** — `markdownlint-cli2`, config in
  `.markdownlint-cli2.jsonc`. Catches structural mistakes: a missing blank
  line around a heading or list, a fenced code block with no language tag,
  more than one top-level heading in a file, inconsistent emphasis markers
  (pick `_underscore_` or `*asterisk*` once per file and stay consistent —
  this repo's convention is `_underscore_` for the italic body notes under a
  heading). Line length is intentionally not enforced (see the writing-prose
  skill's wrap convention instead — that's a human/agent judgment call, not a
  lint rule).
- **`npm run lint:links`** — `remark-cli` + `remark-validate-links`, config in
  `.remarkrc.json`. Walks every relative link between markdown files,
  including `file.md#heading` fragments, and fails on the first dead one —
  a renamed file or a retitled heading breaks the build, not a reader's bug
  report.
- **`npm run lint:docs`** runs both; it's part of `npm run check`, so a dead
  link or a malformed page fails CI the same as a type error.

`docs/reference.md` intentionally keeps several top-level `#` sections as
"parts" of one long document (see above) — that pattern is grandfathered with
an inline `<!-- markdownlint-disable MD024 MD025 -->` comment near its top,
not a global rule change, so a stray extra heading in a `docs/learn/` page is
still caught.

## Decisions

- **Named regions, not line numbers**, for example-code references — line
  ranges silently renumber on unrelated edits; regions can't, and get free
  VS Code folding as a bonus. The `docs-sync` test's failure message reports
  current line numbers regardless, so nothing is lost.
- **Doc examples import from the built package** (`"behalf"`), matching how a
  real consumer would use the library — the same as `examples/simple-chat`
  and `examples/multi-step-agent`. The docs verification script runs `npm run
  build` first so this never requires a manual step.
- **No separate `docs/guides/` folder.** How-to guides live in `docs/learn/`
  alongside concept and tutorial pages, told apart by a verb-phrase slug
  (`add-a-tool.md`) instead of location.
