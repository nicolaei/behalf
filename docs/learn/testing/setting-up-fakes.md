# Setting up fakes

`fakePort` and a fake tool binding let you exercise a whole flow, routing, threading, compaction,
without calling a real model.

## You will learn

- How `fakePort` behaves by default and when to reach for it
- How to script a different response per test case
- How to fake a tool binding with `provide`
- How to combine fakes with `stepUntilBlocked`/`runFlow` from the previous page

## fakePort

`fakePort` is a `ModelPort` that always replies with the fixed text `"ok"` and no tool calls, no
network, no key.
It's the fastest way to prove a flow's shape works at all: every edge that doesn't depend on what
the model actually says.

```ts source=docs/examples/setting-up-fakes/fake-chat.test.ts#fake-port
const assistant: Profile = {
  model: fakePort.model,
  system: "You are a helpful assistant.",
  tools: [],
};

const chat = defineGraph("fake-chat", (flow) => {
  const turn = flow.use(agentTurn(assistant));
  flow.entry(turn);
  turn.then(flow.finish);
});

describe("fakePort", () => {
  it('always replies "ok", with no tool calls', async () => {
    const ready = await runtime({ models: () => fakePort, bindings: [], store: memoryStore() });

    const result = await runFlow(chat, userText("What's the weather?"), ready);

    expect(result).toEqual({ finishedBy: "finalMessage", text: "ok" });
  });
});
```

Reach for `fakePort` when the test doesn't care what the model says: a flow with one path, a wiring
smoke test, anything that would otherwise need to mock an entire response just to get past the model
call.
It can't help once a test needs to steer the model's answer: that's what a scripted port is for.

## Scripting responses

You might reach for a real `ModelPort` here, tuned with a specific prompt to coax a specific reply
out of a real model.
That works, but it's slow and non-deterministic: the same prompt can answer differently twice.
A scripted `ModelPort` sidesteps both problems: its `respond` reads the next entry off a queue you
define, deterministic and instant.

```ts source=docs/examples/setting-up-fakes/fake-chat.test.ts#scripted-port
/** A ModelPort that replies with the next entry in `script`, in order: one reply per `respond()` call, so a test can drive a multi-turn conversation deterministically. Throws once the script runs out, rather than silently repeating its last reply. */
function scriptedPort(script: AssistantMessage["content"][]): ModelPort {
  let call = 0;
  return {
    model: { identifier: "scripted", provider: "test", contextWindow: 100_000, reasoning: [] },
    respond: () => {
      const content = script[call];
      if (!content) throw new Error(`scriptedPort: no script entry for call ${String(call + 1)}`);
      call += 1;
      return Promise.resolve({
        role: "assistant",
        provider: "test",
        model: "scripted",
        content,
        usage: { input: 1, output: 1 },
      });
    },
  };
}

describe("scriptedPort", () => {
  it("replies with a different message each call", async () => {
    const persona: Profile = {
      model: { identifier: "scripted", provider: "test", contextWindow: 100_000, reasoning: [] },
      system: "Say ESCALATE or RESOLVE.",
      tools: [],
    };
    const classify = defineGraph("classify", (flow) => {
      const turn = flow.use(agentTurn(persona));
      flow.entry(turn);
      turn.then(flow.finish);
    });

    const port = scriptedPort([
      [{ type: "text", text: "RESOLVE" }],
      [{ type: "text", text: "ESCALATE" }],
    ]);
    const ready = await runtime({ models: () => port, bindings: [], store: memoryStore() });

    const first = await runFlow(classify, userText("Ticket one."), ready);
    const second = await runFlow(classify, userText("Ticket two."), ready);

    expect(first).toEqual({ finishedBy: "finalMessage", text: "RESOLVE" });
    expect(second).toEqual({ finishedBy: "finalMessage", text: "ESCALATE" });
  });
});
```

This shape (a queue, a call counter, a `respond` that reads the next entry) is common enough to name
once: `scriptedPort`. [Thinking in behalf](../get-started/thinking-in-behalf.md)'s own test file
hand-rolls the same pattern under the same name, before this page existed to name it: whenever a
test needs the model to say something specific, reach for this shape rather than reinventing it.

> [!WARNING] `scriptedPort` throws once its script runs out, rather than silently repeating the last
> entry.
> A test that calls the model more times than it scripted for is usually a sign the flow looped more
> than expected, not that the port needs a longer script.

## Faking a tool

A flow with tools needs bindings for them, the same as production, just backed by a canned result
instead of a real side effect. `provide(tool, handler)` binds a handler exactly like it would in
`runtime()`'s own `bindings` array; the handler here just returns a fixed value instead of doing
real work.

`tool` is the same function [Tools and handlers](../describing-a-flow/tools-and-handlers.md)
introduced; that page left its third argument, a Zod schema, at its default (a permissive record).
Passing one explicitly, as `getWeather` does below, gets real runtime input validation instead of
just compile-time typing.

```ts source=docs/examples/setting-up-fakes/fake-chat.test.ts#fake-tool
const getWeather = tool(
  "get_weather",
  "Look up the current weather for a city.",
  z.object({ city: z.string() }),
);

describe("faking a tool", () => {
  it("resolves a tool call with a canned handler result", async () => {
    const persona: Profile = {
      model: { identifier: "scripted", provider: "test", contextWindow: 100_000, reasoning: [] },
      system: "Look up the weather, then report it.",
      tools: [getWeather],
    };
    const chatWithTool = defineGraph("chat-with-tool", (flow) => {
      const turn = flow.use(agentTurn(persona));
      flow.entry(turn);
      turn.then(flow.finish);
    });

    let handlerCalls = 0;
    const port = scriptedPort([
      [{ type: "toolCall", correlationId: "call-1", name: "get_weather", input: { city: "Oslo" } }],
      [{ type: "text", text: "It's 14°C and sunny in Oslo." }],
    ]);
    const ready = await runtime({
      models: () => port,
      bindings: [
        provide(getWeather, (input) => {
          handlerCalls += 1;
          expect(input).toEqual({ city: "Oslo" });
          return Promise.resolve({ tempC: 14, condition: "sunny" });
        }),
      ],
      store: memoryStore(),
    });

    const result = await runFlow(chatWithTool, userText("What's the weather in Oslo?"), ready);

    expect(handlerCalls).toBe(1);
    expect(result).toEqual({
      finishedBy: "finalMessage",
      text: "It's 14°C and sunny in Oslo.",
    });
  });
});
```

Notice the scripted port's second call still has to supply the follow-up reply: `agentTurn` loops
back to the model once a tool result folds in, so a test with a tool call needs at least two script
entries, one per turn.

## Recap

- `fakePort` always replies `"ok"` with no tool calls: reach for it when a test doesn't care what
  the model says
- A scripted `ModelPort` replies from a per-test queue, one entry per call, deterministic and
  instant
- Name that pattern `scriptedPort`, the same name
  [Thinking in behalf](../get-started/thinking-in-behalf.md) already uses for it
- `provide(tool, handler)` fakes a tool binding the same way `runtime()` wires a real one, just with
  a canned result
- A tool call always costs a second script entry: `agentTurn` loops back to the model once the
  result folds in
- Next: score and compare a persona's outputs with the real eval API, in
  [Evaluating personas](./evaluating-personas.md)

---

**Reference:** reference.md § ModelPort (fakePort sketch), § Full examples #1 under "Systems running
flows" (all-fakes test). **Examples:** `docs/examples/setting-up-fakes/fake-chat.test.ts`, regions:
`fake-port`, `scripted-port`, `fake-tool`. **Section:** [Testing](./README.md) **Prev / Next:**
[Testing your flows](./testing-your-flows.md) / [Evaluating personas](./evaluating-personas.md)
