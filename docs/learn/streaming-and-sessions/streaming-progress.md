# Streaming progress

`openStream` lets a step or a tool handler broadcast partial progress before anything is committed
to the log: the same mechanism a model call uses internally for its own streamed text.

## You will learn

- How `openStream(type)` opens a fresh, logged stream scoped to the current thread
- How to move a `Stream` through its `delta`/`commit`/`abort` lifecycle
- How a slow tool (`search_files`) reports progress this way
- How this relates to a model call's own internal stream

## Opening a stream

A tool that takes a while (a filesystem walk, a slow API call) has nothing worth committing until it
finishes, but a caller watching the session live still wants to see it's making progress.
`openStream(type)` is for exactly that: it opens a stream scoped to the calling thread, tagged with
an event `type` like any other logged event.

```ts source=docs/examples/streaming-progress/search-files.ts#open-stream
  const stream = context.openStream("output");
```

Both `StepContext` and `ToolContext` expose it, so a step can stream its own progress the same way a
tool handler does.
Nothing is written to the log yet: opening a stream only returns a handle.

## delta, commit, abort

The handle back from `openStream` is a `Stream`, and it has exactly three things you can do with it.

```ts source=docs/examples/streaming-progress/search-files.ts#lifecycle
export const progressDemo = tool<{ succeed: boolean }, { done: boolean }>(
  "progress_demo",
  "Streams one delta, then commits or aborts depending on its input.",
);

export const progressDemoBinding: Binding = provide(progressDemo, (input, context) => {
  const stream = context.openStream("output");
  stream.delta({ correlationId: context.correlationId, text: "partial progress" });
  if (input.succeed) stream.commit({ value: { done: true } });
  else stream.abort();
  return Promise.resolve({ done: input.succeed });
});
```

`delta` broadcasts a fragment to anyone watching `store.changes()` right now.
It's never persisted: a client that connects after the fact never sees it, which is why the next
page's [reconnect example](./sessions-and-the-gateway.md#reconnecting) replays the committed log
first and only picks up live deltas afterward. `commit` is what actually lands an event in the log,
the same as `context.output` or any other committed event: it's what a reconnecting client, and
`store.events()`, both see. `abort` is for the case where the work doesn't finish cleanly: it
commits whatever streamed so far and marks the envelope `aborted: true`, instead of leaving the
reader guessing whether anything happened at all.

> [!NOTE] There's no separate cancellation event.
> An aborted stream is still a `committed` envelope, just one with `aborted: true` set: a reader
> checks that flag, not a different event type.

## A slow tool reporting progress

`search_files` puts this together: it opens a stream once, then pushes a delta after every file it
scans, and commits the final match list only once the whole walk is done.

```ts source=docs/examples/streaming-progress/search-files.ts#slow-tool
export const searchFilesBinding: Binding = provide(searchFiles, async (input, context) => {
  const stream = context.openStream("output");
  const files = await collectFiles(input.path);
  const matches: { file: string; line: number }[] = [];
  let scanned = 0;
  for (const file of files) {
    try {
      const content = await readFile(file, "utf-8");
      content.split("\n").forEach((line, index) => {
        if (line.includes(input.query)) matches.push({ file, line: index + 1 });
      });
    } catch {
      // unreadable file (binary, permissions, etc.): skip it, keep searching
    }
    scanned++;
    stream.delta({
      correlationId: context.correlationId,
      text: `scanned ${String(scanned)}/${String(files.length)} files (${String(matches.length)} hits so far)`,
    });
  }
  stream.commit({ value: { matches } });
  return { matches };
});
```

Notice `context.correlationId`, not a value the handler invents: it's the same id this tool call's
own `toolCall`/`toolResult` pair carries, so a UI can line a progress line up with the right tool
card while several tool calls run at once.
This is also why a model call opens a stream of its own: streaming the model's own text uses the
identical `delta`/`commit` shape, tagged with the model's own `correlationId` instead of a tool's.
See [Model ports and bindings](../wiring-a-runtime/model-ports-and-bindings.md) for how a
`ModelPort` receives that same `stream` handle.

## Recap

- `openStream(type)` opens a fresh, logged stream scoped to the calling thread; both `StepContext`
  and `ToolContext` expose it
- `delta` broadcasts a fragment live, never persisted; `commit` finalizes an event into the log;
  `abort` commits what streamed and marks the envelope `aborted: true`
- A slow tool like `search_files` opens one stream, pushes a delta per unit of work, and commits
  once at the end
- A model call streams its own reply through the identical mechanism
- Next: how a client sees all of this land, in
  [Sessions and the gateway](./sessions-and-the-gateway.md)

---

**Reference:** reference.md § StepContext (openStream), § Session store (Stream, Event/Envelope
delta form). **Examples:** `docs/examples/streaming-progress/search-files.ts`, regions
`open-stream`, `lifecycle`, `slow-tool`. **Section:** [Streaming and sessions](./README.md) **Prev /
Next:** [Evaluating personas](../testing/evaluating-personas.md) /
[Sessions and the gateway](./sessions-and-the-gateway.md)
