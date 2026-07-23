# Tools and handlers

A `tool` declares one typed capability; a `ToolHandler` implements it; `provide`/`expand` bind the
two together.

## You will learn

- The difference between a `tool` and a `toolset`
- How to write a `ToolHandler` and what its `ToolContext` gives it
- How `provide` binds a `tool` and `expand` binds a `toolset`
- How a handler streams progress
- How a handler spawns a child flow

## Declaring a tool

`tool<Input, Output>(name, describe)` declares one capability by name, description, and its typed
input and output.
A `toolset` is different: it's a group produced together, like everything an MCP server exposes, or
a curated bundle you assemble yourself, whose individual members only appear once it's expanded.

```ts source=docs/examples/tools-and-handlers/search-tool.ts#tool
export const search = tool<{ query: string }, { hits: string[] }>(
  "search",
  "Search the internal knowledge base for articles matching a query.",
);
```

A `Profile`'s `tools` array can hold both `Tool` and `Toolset` entries side by side: the persona
doesn't need to know which one a given entry is, only that it's available.

## Writing a handler

A `ToolHandler` is the implementation behind a `tool`: it takes the typed input and a `ToolContext`,
and returns the typed output.

```ts source=docs/examples/tools-and-handlers/search-tool.ts#handler
export const searchHandler: ToolHandler<{ query: string }, { hits: string[] }> = (
  { query },
  context,
) => {
  // context.correlationId ties this call to its own toolCall/toolResult pair in the
  // log, in case a handler needs a key to check whether it already ran on resume.
  void context.correlationId;
  const hits = knowledgeBase.filter((article) =>
    article.toLowerCase().includes(query.toLowerCase()),
  );
  return Promise.resolve({ hits });
};
```

Notice `context.correlationId`: every call gets its own, matching the `toolCall`/`toolResult` pair
this run will log.
A handler owns its own idempotency, because it may re-run on resume: if your handler has a side
effect that shouldn't repeat, `correlationId` is the key to check against.

## Binding: provide and expand

`provide` binds a concrete handler to a `Tool` reference; `expand` binds a discover callback to a
`Toolset`, resolved once the flow needs it.
They aren't interchangeable: `provide` expects a handler shaped for one typed tool, `expand` expects
a callback that resolves a whole `Record` of handlers by name, and passing either to the wrong
function is a compile error, not a runtime one.

```ts source=docs/examples/tools-and-handlers/search-tool.ts#binding
export const searchBinding: Binding = provide(search, searchHandler);

const supportBundle = toolset("support-bundle", "Curated support tools, expanded at runtime.");
export const supportBundleBinding: Binding = expand(supportBundle, () =>
  Promise.resolve({ search: searchHandler as ToolHandler }),
);
```

A runtime's `bindings` array holds both kinds together: a step calling a tool doesn't need to know
whether its binding came from a direct `provide` or an expanded `toolset`.

## Streaming progress and spawning a sub-flow

`ToolContext` carries two more capabilities this page only names: `context.openStream` opens a live,
logged stream for a handler that takes a while and wants to report progress as it goes, and
`context.runFlow` lets a handler spawn a child flow and await its result, the way a research tool
might launch a whole sub-agent.
[Streaming progress](../streaming-and-sessions/streaming-progress.md) and
[Fan-out and joining](../agents-in-practice/fan-out-and-joining.md) cover each in full.

## Recap

- `tool<Input, Output>(name, describe)` declares one typed capability; `toolset(name, describe)`
  declares a group whose members appear when expanded
- A `ToolHandler` takes typed input and a `ToolContext`, and owns its own idempotency since it may
  re-run on resume
- `context.correlationId` matches a handler's own `toolCall`/`toolResult` pair
- `provide` binds a `tool`, `expand` binds a `toolset`; mixing them up is a compile error
- `context.openStream` and `context.runFlow` cover progress streaming and spawning a sub-flow
- Next: how these turns run in a loop end to end, in
  [The agent loop](../agents-in-practice/the-agent-loop.md)

---

**Reference:** reference.md § tool / toolset, § ToolHandler, § provide / expand. **Examples:**
`docs/examples/tools-and-handlers/search-tool.ts`, regions `tool`, `handler`, `binding`.
**Section:** [Describing a flow](./README.md) **Prev / Next:**
[Profiles and models](./profiles-and-models.md) /
[The agent loop](../agents-in-practice/the-agent-loop.md)
