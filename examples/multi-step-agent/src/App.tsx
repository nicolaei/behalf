// UI for the four-stage pipeline: a full-screen TUI, alternate screen buffer
// and all. No Ink <Static> anywhere — everything is reactive, and the whole
// app is one Box sized to exactly the terminal's height. The header and
// stage strip take their natural height; the transcript viewport below them
// gets `flexGrow` for whatever's left, with `overflow="hidden"` and
// `justifyContent="flex-end"` so Ink's own layout engine (which knows real
// wrapped-text heights, not an approximation) clips from the top and always
// keeps the most recent content visible at the bottom — auto-following as
// new content arrives. Older history still exists in the `transcript` array,
// it's just clipped from view — this trades native terminal scrollback for a
// frame that can never exceed the terminal height by construction, so it
// never has trouble erasing-and-redrawing itself in place. A specialized
// `ask` tool card renders an inline TextInput instead of a generic tool card
// while the ask is pending.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useStdout } from "ink";
import TextInput from "ink-text-input";
import { runFlow, userText } from "behalf";
import type { Runtime, Message, StepError, ThreadId } from "behalf";
import { pipeline } from "./pipeline.js";
import { DEFAULT_MODEL, askerProfile } from "./profiles.js";
import type { AskBridge, PendingAsk } from "./ask-bridge.js";

export const MODEL_ID = DEFAULT_MODEL.identifier;
export const REASONING_LEVEL = askerProfile.reasoning;

const STAGE_NAMES = ["asker", "red", "green", "refactor"] as const;
type StageName = (typeof STAGE_NAMES)[number];

type TranscriptEntry =
  | { kind: "banner"; stage: StageName }
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
  return undefined; // system/tool messages: skip silently
}

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
 * calls are usually shown, e.g. `● Bash <command>`, not the raw tool name. */
function toolLabel(name: string): string {
  switch (name) {
    case "run_bash":
      return "Bash";
    case "write_file":
      return "Write";
    case "edit_file":
      return "Edit";
    case "ask":
      return "Ask";
    case "submit_spec":
      return "Submit spec";
    default:
      return name;
  }
}

/** The one piece of a tool call's input worth showing inline — the command
 * that ran, the path touched, the question asked — never the full input
 * object, and never its output/result. */
function toolSummary(name: string, input: unknown): string {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  switch (name) {
    case "run_bash":
      return String(record.command ?? "");
    case "write_file":
    case "edit_file":
      return String(record.path ?? "");
    case "ask":
      return String(record.question ?? "");
    case "submit_spec":
      return String(record.page ?? "");
    default:
      return formatValue(input);
  }
}

/** Flattens one transcript entry into the individual terminal rows it renders as. */
function linesForEntry(entry: TranscriptEntry, index: number): Line[] {
  if (entry.kind === "banner") {
    return [{ key: `${index}-banner`, node: <Text dimColor>── {entry.stage} ──</Text> }];
  }
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
  // entry.kind === "tool" — a single line: bullet, tool label, the one
  // input value worth showing (the command/path/question, never the full
  // input object), and elapsed time once done. Never the output/result.
  if (!entry.done && entry.name === "ask") {
    // Rendered specially below via pendingAsk/AskCard, not as a plain tool
    // line — this is just a placeholder while it's pending.
    return [{ key: entry.correlationId, node: <Text dimColor>? waiting on your answer…</Text> }];
  }
  const elapsed =
    entry.done && entry.elapsedMs !== undefined ? ` (${(entry.elapsedMs / 1000).toFixed(1)}s)` : "";
  const text = `● ${toolLabel(entry.name)} ${toolSummary(entry.name, entry.input)}${elapsed}`;
  return [
    {
      key: entry.correlationId,
      node: <Text color={entry.done && entry.isError ? "red" : undefined}>{text}</Text>,
    },
  ];
}

/** Stage strip segment: done stages before the current one, current one, then pending. */
function StageStrip({ current }: { current: StageName | undefined }) {
  const currentIndex = current ? STAGE_NAMES.indexOf(current) : -1;
  return (
    <Text>
      {STAGE_NAMES.map((name, index) => {
        const marker = index < currentIndex ? "✓" : index === currentIndex ? "●" : "○";
        const separator = index < STAGE_NAMES.length - 1 ? "  " : "";
        return (
          <Text key={name} bold={index === currentIndex} dimColor={index > currentIndex}>
            {marker} {name}
            {separator}
          </Text>
        );
      })}
    </Text>
  );
}

function AskCard({
  pending,
  onSubmit,
}: {
  pending: PendingAsk;
  onSubmit: (answer: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="cyan">
        ? {pending.question}
      </Text>
      <Box>
        <Text dimColor>{"> "}</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={(text) => {
            const trimmed = text.trim();
            if (!trimmed) return;
            setValue("");
            onSubmit(trimmed);
          }}
        />
      </Box>
    </Box>
  );
}

export function App({ ready, askBridge }: { ready: Runtime; askBridge: AskBridge }) {
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout.rows || 24);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [streaming, setStreaming] = useState<StreamingReply | undefined>(undefined);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | undefined>(undefined);
  const [currentStage, setCurrentStage] = useState<StageName | undefined>(undefined);
  const started = useRef(false);
  const stageByThread = useRef(new Map<ThreadId, StageName>());
  const nextStageIndex = useRef(0);

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

  useEffect(
    () => askBridge.subscribe((pending) => setPendingAsk(pending ?? undefined)),
    [askBridge],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for await (const envelope of ready.store.changes()) {
        if (cancelled) return;

        // Track stage-by-threadId by order of first appearance, and insert a
        // banner into the transcript the first time each stage's thread shows up.
        const threadId = envelope.threadId;
        if (threadId && !stageByThread.current.has(threadId)) {
          const stage = STAGE_NAMES[nextStageIndex.current];
          if (stage) {
            stageByThread.current.set(threadId, stage);
            nextStageIndex.current += 1;
            setCurrentStage(stage);
            setTranscript((previous) => [...previous, { kind: "banner", stage }]);
          }
        }

        if (envelope.form === "delta") {
          const delta = envelope.delta;
          if ("open" in delta) {
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
            setTranscript((previous) =>
              previous.map((entry) =>
                entry.kind === "tool" && entry.correlationId === delta.correlationId
                  ? { ...entry, progress: delta.text }
                  : entry,
              ),
            );
            continue;
          }
          continue;
        }

        if (envelope.form !== "committed") continue; // skip in-progress snapshots
        if (envelope.type === "message") {
          const message = (envelope.event as { message: Message }).message;
          const entry = entryOf(message);
          if (entry) setTranscript((previous) => [...previous, entry]);
          setStreaming(undefined);
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
      runFlow(pipeline, userText(trimmed), ready).catch((cause) => {
        setError(formatRunError(cause));
      });
    }
    // After the opening message, further free-text input isn't wired to
    // anything — the pipeline advances only via `ask` tool cards.
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
      <Text bold>multi-step-agent</Text>
      <Text dimColor>
        model: {MODEL_ID} · reasoning: {REASONING_LEVEL}
      </Text>
      <Box marginY={1}>
        <StageStrip current={currentStage} />
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden" justifyContent="flex-end">
        {allLines.length === 0 && <Text dimColor>(describe the page you want below to start)</Text>}
        {allLines.map((line) => (
          <Box key={line.key}>{line.node}</Box>
        ))}
        {error && <Text color="red">Error: {error}</Text>}
      </Box>
      {pendingAsk ? (
        <Box marginTop={1}>
          <AskCard pending={pendingAsk} onSubmit={(answer) => pendingAsk.resolve(answer)} />
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>{"> "}</Text>
          <TextInput value={input} onChange={setInput} onSubmit={submit} />
        </Box>
      )}
    </Box>
  );
}
