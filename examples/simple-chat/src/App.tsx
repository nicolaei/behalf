// A full-screen TUI, alternate screen buffer and all — same shell as
// multi-step-agent. No Ink <Static> anywhere — everything is reactive, and
// the whole app is one Box sized to exactly the terminal's height. The
// header takes its natural height; the transcript viewport below it gets
// `flexGrow` for whatever's left, with `overflow="hidden"` and
// `justifyContent="flex-end"` so Ink's own layout engine (which knows real
// wrapped-text heights, not an approximation) clips from the top and always
// keeps the most recent content visible at the bottom — auto-following as
// new content arrives. Older history still exists in the `transcript` array,
// it's just clipped from view — this trades native terminal scrollback for a
// frame that can never exceed the terminal height by construction. `message`
// events become chat lines (role on its own line, body indented below),
// `toolCall`/`toolResult` events become single-line tool cards (bullet,
// human label, the one input value worth showing, elapsed time once done —
// never the full input object or the output). The text input drives the
// chat graph: the first submit kicks off `runFlow`, every following submit
// is a "follow-up" message fed into the running flow via `store.receive`.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useStdout } from "ink";
import TextInput from "ink-text-input";
import { runFlow, userText } from "behalf";
import type { Runtime, Message, StepError } from "behalf";
import { chat, DEFAULT_MODEL, assistant } from "./chat.js";

export const MODEL_ID = DEFAULT_MODEL.identifier;
export const REASONING_LEVEL = assistant.reasoning;

type TranscriptEntry =
  | { kind: "message"; role: "user" | "assistant" | "other"; text: string; thinkingChars?: number }
  | {
      kind: "tool";
      correlationId: string;
      name: string;
      input: unknown;
      output?: unknown;
      isError?: boolean;
      done: boolean;
      startedAt: number;
      elapsedMs?: number;
      progress?: string;
    };

type StreamingReply = { correlationId: string; text: string };

/** One flattened, already-styled terminal row — the unit the viewport clips over. */
type Line = { key: string; node: React.ReactNode };

// However long a real session runs, only the last this-many flattened lines
// are ever kept around — a plain perf/memory guard, unrelated to what's
// actually visible (Ink's own layout clips that precisely on its own).
const MAX_KEPT_LINES = 2000;

function textOf(message: Message): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

// Thinking blocks carry the model's own reasoning — never dumped into the
// transcript verbatim, just surfaced as a collapsed char count.
function thinkingCharsOf(message: Message): number | undefined {
  const chars = message.content
    .filter(
      (block): block is Extract<typeof block, { type: "thinking" }> => block.type === "thinking",
    )
    .reduce((total, block) => total + block.text.length, 0);
  return chars > 0 ? chars : undefined;
}

function entryOf(message: Message): TranscriptEntry | undefined {
  if (message.role === "user") return { kind: "message", role: "user", text: textOf(message) };
  if (message.role === "assistant")
    return {
      kind: "message",
      role: "assistant",
      text: textOf(message),
      thinkingChars: thinkingCharsOf(message),
    };
  return undefined; // system messages: skip silently
}

// A rejected `runFlow` is always a plain `Error` whose `.cause` is the
// `StepError` the failing step (or `handleStepError`'s retry-exhausted path)
// built — see `handleStepError` in src/engine/runtime/step-runner.ts:
// `throw new Error(emit.error.message, { cause: emit.error })`. Surface the
// StepError's `type` too, not just the generic message string.
function formatRunError(cause: unknown): string {
  const stepError =
    cause instanceof Error &&
    cause.cause &&
    typeof cause.cause === "object" &&
    "type" in cause.cause
      ? (cause.cause as StepError)
      : undefined;
  if (stepError) return `[${stepError.type}] ${stepError.message}`;
  return cause instanceof Error ? cause.message : String(cause);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Human-readable label for a tool call — matches how a CLI agent's own tool
 * calls are usually shown, e.g. `● Read <path>`, not the raw tool name. */
function toolLabel(name: string): string {
  switch (name) {
    case "read":
      return "Read";
    case "list_directory":
      return "List";
    case "cwd":
      return "Cwd";
    case "search_files":
      return "Search";
    default:
      return name;
  }
}

/** The one piece of a tool call's input worth showing inline — the path
 * touched, the query searched — never the full input object, and never its
 * output/result. */
function toolSummary(name: string, input: unknown): string {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  switch (name) {
    case "read":
    case "list_directory":
      return String(record.path ?? "");
    case "cwd":
      return "";
    case "search_files":
      return `${String(record.path ?? "")} "${String(record.query ?? "")}"`;
    default:
      return formatValue(input);
  }
}

/** Flattens one transcript entry into the individual terminal rows it renders as. */
function linesForEntry(entry: TranscriptEntry, index: number): Line[] {
  if (entry.kind === "message") {
    const lines: Line[] = [];
    if (entry.thinkingChars !== undefined) {
      lines.push({
        key: `${index}-thinking`,
        node: <Text dimColor>💭 (thinking, {entry.thinkingChars} chars)</Text>,
      });
    }
    lines.push({
      key: `${index}-role`,
      node: <Text bold>{entry.role === "user" ? "You:" : "Assistant:"}</Text>,
    });
    lines.push({ key: `${index}-body`, node: <Text> {entry.text}</Text> });
    lines.push({ key: `${index}-spacer`, node: <Text> </Text> });
    return lines;
  }
  // entry.kind === "tool" — a single line: bullet, tool label, the one input
  // value worth showing (never the full input object), and elapsed time once
  // done. Never the output/result.
  const elapsed =
    entry.done && entry.elapsedMs !== undefined ? ` (${(entry.elapsedMs / 1000).toFixed(1)}s)` : "";
  const summary = toolSummary(entry.name, entry.input);
  const text = `● ${toolLabel(entry.name)}${summary ? ` ${summary}` : ""}${elapsed}`;
  return [
    {
      key: entry.correlationId,
      node: <Text color={entry.done && entry.isError ? "red" : undefined}>{text}</Text>,
    },
  ];
}

export function App({ ready }: { ready: Runtime }) {
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout.rows || 24);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [streaming, setStreaming] = useState<StreamingReply | undefined>(undefined);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const started = useRef(false);

  // A real full-screen TUI: take over the alternate screen buffer on mount,
  // hand it back on exit. Nothing here is normal terminal scrollback anymore.
  useEffect(() => {
    stdout.write("\x1b[?1049h");
    return () => {
      stdout.write("\x1b[?1049l");
    };
  }, [stdout]);

  // Terminal height sizes the whole app — re-measure on resize.
  useEffect(() => {
    const onResize = () => setRows(stdout.rows || 24);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for await (const envelope of ready.store.changes()) {
        if (cancelled) return;

        if (envelope.form === "delta") {
          const delta = envelope.delta;
          if ("open" in delta) {
            // Only the assistant's own text streams live — a toolCall's
            // open/partialInput deltas just get a live progress card.
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
            // A tool's own progress deltas share its toolCall's correlationId —
            // route them onto the matching tool card instead of the assistant
            // reply when they don't match the in-flight streamed message.
            setTranscript((previous) =>
              previous.map((entry) =>
                entry.kind === "tool" && entry.correlationId === delta.correlationId
                  ? { ...entry, progress: delta.text }
                  : entry,
              ),
            );
            continue;
          }
          continue; // partialInput/close: not rendered
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
              startedAt: Date.now(),
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
                ? {
                    ...entry,
                    output: result.output,
                    isError: result.isError,
                    done: true,
                    elapsedMs: Date.now() - entry.startedAt,
                  }
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
        setError(formatRunError(cause));
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

  const allLines = useMemo(() => {
    const lines = transcript.flatMap((entry, index) => linesForEntry(entry, index));
    if (streaming) {
      lines.push({ key: "streaming-role", node: <Text bold>Assistant:</Text> });
      lines.push({
        key: "streaming-body",
        node: (
          <Text>
            {" "}
            {streaming.text}
            <Text dimColor>▌</Text>
          </Text>
        ),
      });
    }
    return lines.length > MAX_KEPT_LINES ? lines.slice(-MAX_KEPT_LINES) : lines;
  }, [transcript, streaming]);

  return (
    <Box flexDirection="column" height={rows}>
      <Text bold>simple-chat</Text>
      <Text dimColor>
        model: {MODEL_ID} · reasoning: {REASONING_LEVEL}
      </Text>
      <Text dimColor>cwd: {process.cwd()}</Text>
      <Box
        flexDirection="column"
        flexGrow={1}
        marginTop={1}
        overflow="hidden"
        justifyContent="flex-end"
      >
        {allLines.length === 0 && <Text dimColor>(no messages yet — type below)</Text>}
        {allLines.map((line) => (
          <Box key={line.key}>{line.node}</Box>
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
