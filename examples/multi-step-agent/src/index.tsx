import React, { useEffect, useState } from "react";
import { render, Box, Text } from "ink";
import { runtime, adapters, provide } from "behalf";
import type { Runtime, Binding } from "behalf";
import { App } from "./App.js";
import { DEFAULT_MODEL } from "./profiles.js";
import { fsBindings } from "./tools/fs.js";
import { ask } from "./tools/ask.js";
import { submitSpec } from "./tools/submit-spec.js";
import { createAskBridge } from "./ask-bridge.js";
import { rateLimitBackoff } from "./retry.js";

// The `ask` tool's own promise IS the pending question; the UI resolves it
// directly via askBridge, never through `ready.store.receive`.
export const askBridge = createAskBridge();

const askBinding: Binding = provide(ask, ({ question }) => askBridge.ask(question));

// `submit_spec` has no real side effect — its whole job is to be
// `agentTurn`'s `finishOn` target, so its binding just echoes its input back.
const submitSpecBinding: Binding = provide(submitSpec, (input) => Promise.resolve(input));

const bindings: Binding[] = [...fsBindings, askBinding, submitSpecBinding];

function Root() {
  const [ready, setReady] = useState<Runtime | undefined>(undefined);
  const [startupError, setStartupError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    runtime({
      models: () => adapters.models.createAnthropicPort(DEFAULT_MODEL),
      bindings,
      errorHandlers: [rateLimitBackoff],
      store: adapters.stores.memoryStore(),
    }).then(
      (resolved) => {
        if (!cancelled) setReady(resolved);
      },
      (cause) => {
        if (!cancelled) setStartupError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (startupError) {
    return (
      <Box paddingX={1}>
        <Text color="red">Failed to start: {startupError}</Text>
      </Box>
    );
  }

  if (!ready) {
    return (
      <Box paddingX={1}>
        <Text dimColor>starting…</Text>
      </Box>
    );
  }

  return <App ready={ready} askBridge={askBridge} />;
}

render(<Root />);
