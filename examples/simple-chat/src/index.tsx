import React, { useEffect, useState } from "react";
import { render, Box, Text } from "ink";
import { runtime } from "@behalf-js/core";
import type { Runtime } from "@behalf-js/core";
import { createAnthropicPort } from "@behalf-js/models-anthropic";
import { memoryStore } from "@behalf-js/stores";
import { App } from "./App.js";
import { DEFAULT_MODEL } from "./chat.js";
import { fsBindings } from "./tools.js";
import { rateLimitBackoff } from "./retry.js";

function Root() {
  const [ready, setReady] = useState<Runtime | undefined>(undefined);
  const [startupError, setStartupError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    runtime({
      models: () => createAnthropicPort(DEFAULT_MODEL),
      bindings: fsBindings,
      errorHandlers: [rateLimitBackoff],
      store: memoryStore(),
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

  return <App ready={ready} />;
}

render(<Root />);
