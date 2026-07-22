// M4 — delta streaming for the model's own text: subscribes to "delta" form
// envelopes alongside committed ones, growing an in-flight assistant reply
// character by character as text deltas arrive, then finalizing into the
// normal transcript once the underlying "message" commits. Renders a
// scrolling transcript folded from the store's committed envelopes:
// `message` events become chat lines, `toolCall`/`toolResult` events become
// commit-only tool cards (no spinner — a static running indicator is enough
// for M3/M4; live tool progress is M5). The text input drives the chat
// graph: the first submit kicks off `runFlow`, every following submit is a
// "follow-up" message fed into the running flow via `store.receive`.
import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { runFlow, userText } from "behalf";
import type { Runtime, Message } from "behalf";
import { chat, DEFAULT_MODEL, assistant } from "./chat.js";

export const MODEL_ID = DEFAULT_MODEL.identifier;
export const REASONING_LEVEL = assistant.reasoning;

type TranscriptEntry =
  | { kind: "message"; role: "user" | "assistant" | "other"; text: string }
  | {
      kind: "tool";
      correlationId: string;
      name: string;
      input: unknown;
      output?: unknown;
      isError?: boolean;
      done: boolean;
    };

type StreamingReply = { correlationId: string; text: string };

function textOf(message: Message): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function entryOf(message: Message): TranscriptEntry | undefined {
  if (message.role === "user") return { kind: "message", role: "user", text: textOf(message) };
  if (message.role === "assistant")
    return { kind: "message", role: "assistant", text: textOf(message) };
  return undefined; // system messages: skip silently
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function App({ ready }: { ready: Runtime }) {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [streaming, setStreaming] = useState<StreamingReply | undefined>(undefined);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const started = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for await (const envelope of ready.store.changes()) {
        if (cancelled) return;

        if (envelope.form === "delta") {
          const delta = envelope.delta;
          if ("open" in delta) {
            // Only the assistant's own text streams live in M4 — a toolCall's
            // open/partialInput deltas get a live progress card in M5.
            if (delta.open === "text")
              setStreaming({ correlationId: delta.correlationId, text: "" });
            continue;
          }
          if ("text" in delta) {
            setStreaming((previous) =>
              previous && previous.correlationId === delta.correlationId
                ? { ...previous, text: previous.text + delta.text }
                : previous,
            );
            continue;
          }
          continue; // partialInput/close: not rendered in M4
        }

        if (envelope.form !== "committed") continue; // skip in-progress snapshots
        if (envelope.type === "message") {
          const message = (envelope.event as { message: Message }).message;
          const entry = entryOf(message);
          if (entry) setTranscript((previous) => [...previous, entry]);
          setStreaming(undefined); // the streamed reply just landed as a real message
          continue;
        }
        if (envelope.type === "toolCall") {
          const call = envelope.event as { correlationId: string; name: string; input: unknown };
          setTranscript((previous) => [
            ...previous,
            {
              kind: "tool",
              correlationId: call.correlationId,
              name: call.name,
              input: call.input,
              done: false,
            },
          ]);
          continue;
        }
        if (envelope.type === "toolResult") {
          const result = envelope.event as {
            correlationId: string;
            output: unknown;
            isError?: boolean;
          };
          setTranscript((previous) =>
            previous.map((entry) =>
              entry.kind === "tool" && entry.correlationId === result.correlationId
                ? { ...entry, output: result.output, isError: result.isError, done: true }
                : entry,
            ),
          );
          continue;
        }
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
        {transcript.length === 0 && !streaming && (
          <Text dimColor>(no messages yet — type below)</Text>
        )}
        {transcript.map((entry, index) => {
          if (entry.kind === "message") {
            return (
              <Text key={index}>
                <Text bold>{entry.role === "user" ? "You: " : "Assistant: "}</Text>
                {entry.text}
              </Text>
            );
          }
          const status = entry.done
            ? entry.isError
              ? `✗ ${formatValue(entry.output)}`
              : `→ ${formatValue(entry.output)}`
            : "…";
          return (
            <Text key={entry.correlationId} dimColor>
              🔧 {entry.name}({formatValue(entry.input)}) {status}
            </Text>
          );
        })}
        {streaming && (
          <Text>
            <Text bold>Assistant: </Text>
            {streaming.text}
            <Text dimColor>▌</Text>
          </Text>
        )}
        {error && <Text color="red">Error: {error}</Text>}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{"> "}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={submit} />
      </Box>
    </Box>
  );
}
