// M2 — real interactive multi-turn conversation. No tools, no delta streaming
// (those are M3/M4). Renders a scrolling transcript folded from the store's
// committed message envelopes, and a text input that drives the chat graph:
// the first submit kicks off `runFlow`, every following submit is a
// "follow-up" message fed into the running flow via `store.receive`.
import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { runFlow, userText } from "behalf";
import type { Runtime, Message } from "behalf";
import { chat, DEFAULT_MODEL, assistant } from "./chat.js";

export const MODEL_ID = DEFAULT_MODEL.identifier;
export const REASONING_LEVEL = assistant.reasoning;

type TranscriptEntry = {
  role: "user" | "assistant" | "other";
  text: string;
};

function textOf(message: Message): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function entryOf(message: Message): TranscriptEntry | undefined {
  if (message.role === "user") return { role: "user", text: textOf(message) };
  if (message.role === "assistant") return { role: "assistant", text: textOf(message) };
  return undefined; // system/tool messages: skip silently, no tools in M2
}

export function App({ ready }: { ready: Runtime }) {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const started = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for await (const envelope of ready.store.changes()) {
        if (cancelled) return;
        if (envelope.form !== "committed" || envelope.type !== "message") continue;
        const message = (envelope.event as { message: Message }).message;
        const entry = entryOf(message);
        if (entry) setTranscript((previous) => [...previous, entry]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready]);

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setInput("");
    if (!started.current) {
      started.current = true;
      runFlow(chat, userText(trimmed), ready).catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
      return;
    }
    ready.store.receive({
      kind: "message",
      message: {
        role: "user",
        intent: "standard",
        kind: "follow-up",
        content: [{ type: "text", text: trimmed }],
      },
    });
  }

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold> simple-chat </Text>
      <Text dimColor>
        model: {MODEL_ID} · reasoning: {REASONING_LEVEL}
      </Text>
      <Text dimColor>cwd: {process.cwd()}</Text>
      <Box flexDirection="column" marginTop={1}>
        {transcript.length === 0 && <Text dimColor>(no messages yet — type below)</Text>}
        {transcript.map((entry, index) => (
          <Text key={index}>
            <Text bold>{entry.role === "user" ? "You: " : "Assistant: "}</Text>
            {entry.text}
          </Text>
        ))}
        {error && <Text color="red">Error: {error}</Text>}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{"> "}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={submit} />
      </Box>
    </Box>
  );
}
