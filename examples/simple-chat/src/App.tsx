// M0 — static scaffold: proves Ink renders. No engine wiring yet.
import React from "react";
import { Box, Text } from "ink";

export const MODEL_ID = "claude-sonnet-5";
export const REASONING_LEVEL = "medium";

export function App() {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold> simple-chat </Text>
      <Text dimColor>
        model: {MODEL_ID} · reasoning: {REASONING_LEVEL}
      </Text>
      <Text dimColor>cwd: {process.cwd()}</Text>
      <Box marginTop={1}>
        <Text dimColor>(scaffold — chat wiring comes next)</Text>
      </Box>
    </Box>
  );
}
