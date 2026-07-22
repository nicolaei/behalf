// UI for the four-stage pipeline: a stage strip (asker/red/green/refactor,
// derived from thread-id order of first appearance), a transcript folded
// from the store's committed envelopes (message/toolCall/toolResult, plus
// delta streaming for the model's own text — same pattern as simple-chat),
// stage-boundary banners inserted whenever a new threadId first appears, and
// a specialized `ask` tool card that renders an inline TextInput instead of
// a generic tool card while the ask is pending.

import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
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

function AskCard({ pending, onSubmit }: { pending: PendingAsk; onSubmit: (answer: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="cyan">
        ❓ {pending.question}
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
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [streaming, setStreaming] = useState<StreamingReply | undefined>(undefined);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | undefined>(undefined);
  const [currentStage, setCurrentStage] = useState<StageName | undefined>(undefined);
  const started = useRef(false);
  const stageByThread = useRef(new Map<ThreadId, StageName>());
  const nextStageIndex = useRef(0);

  useEffect(() => askBridge.subscribe((pending) => setPendingAsk(pending ?? undefined)), [askBridge]);

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
            if (delta.open === "text") setStreaming({ correlationId: delta.correlationId, text: "" });
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

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold> multi-step-agent </Text>
      <Text dimColor>
        model: {MODEL_ID} · reasoning: {REASONING_LEVEL}
      </Text>
      <Box marginY={1}>
        <StageStrip current={currentStage} />
      </Box>
      <Box flexDirection="column">
        {transcript.length === 0 && !streaming && (
          <Text dimColor>(describe the page you want below to start)</Text>
        )}
        {transcript.map((entry, index) => {
          if (entry.kind === "banner") {
            return (
              <Text key={index} dimColor>
                ── {entry.stage} ──
              </Text>
            );
          }
          if (entry.kind === "message") {
            return (
              <Box key={index} flexDirection="column">
                {entry.thinkingChars !== undefined && (
                  <Text dimColor>💭 (thinking, {entry.thinkingChars} chars)</Text>
                )}
                <Text>
                  <Text bold>{entry.role === "user" ? "You: " : "Assistant: "}</Text>
                  {entry.text}
                </Text>
              </Box>
            );
          }
          if (entry.name === "ask" && !entry.done) {
            // Rendered specially below via pendingAsk/AskCard, not as a plain
            // tool card — skip the generic rendering for it here.
            return (
              <Text key={entry.correlationId} dimColor>
                ❓ waiting on your answer…
              </Text>
            );
          }
          const elapsed =
            entry.elapsedMs !== undefined ? ` (${(entry.elapsedMs / 1000).toFixed(1)}s)` : "";
          const status = entry.done
            ? entry.isError
              ? `✗ ${formatValue(entry.output)}${elapsed}`
              : `→ ${formatValue(entry.output)}${elapsed}`
            : (entry.progress ?? "…");
          return (
            <Text
              key={entry.correlationId}
              color={entry.done && entry.isError ? "red" : undefined}
              dimColor={!(entry.done && entry.isError)}
            >
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
      {pendingAsk && (
        <Box marginTop={1}>
          <AskCard pending={pendingAsk} onSubmit={(answer) => pendingAsk.resolve(answer)} />
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>{"> "}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={submit} />
      </Box>
    </Box>
  );
}
