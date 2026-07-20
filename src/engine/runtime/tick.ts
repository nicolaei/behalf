// Tick and replay: reconstructs where a flow last left off purely from the
// event log, advances it exactly one node, and the `tickUntilSuspended`
// helper that repeats until every cursor is parked or done.

import type { Graph, NodeId } from "../../flow/graph.js";
import type { Message, MessageKind } from "../../flow/message.js";
import type { StepContext, WaitForResult } from "../../flow/step.js";
import type { Event } from "../../session/event.js";
import type { Runtime } from "../runtime.js";
import { freshThreadId } from "./ids.js";
import { notImplemented, unreachable } from "../errors.js";
import {
  type Thread,
  stepIdentity,
  appendOutput,
  route,
  commitRoute,
  pushMessage,
  thenEdges,
} from "./routing.js";
import { runStep, assertJoinTagging } from "./step-runner.js";
import {
  type FanOutGroup,
  buildFanOutGroup,
  foldGroup,
  replayBranchOutput,
  advanceFanOutGroup,
  branchCursorState,
} from "./fan-out.js";
import {
  type InterruptNode,
  buildDriveContext,
  driveStepEmit,
  findInterruptNodes,
  looksLikeMessage,
} from "./drive.js";

/** One cursor's current state within a tick() outcome — node, status, and (for parked) what it's waiting for. */
export interface CursorState {
  node: NodeId;
  status: "active" | "parked" | "done";
  waitingFor?: MessageKind[]; // present only when status is "parked"
  result?: unknown; // present only when status is "done" (root cursor only)
  parent?: string; // absent = this is the root cursor; present = identifies which cursor this folds into
}

/** One tick()'s outcome: a set of independently-progressing cursors. For single-cursor flows, always a one-element array. */
export type TickOutcome = CursorState[];

/** One level of a replayed `tick()` position — the outermost flow, or a `use` node's subgraph descended into it. `useNodeId` is the id, in the ENCLOSING frame's own flow, of the `use` node whose subgraph this frame reconstructs; absent only for the outermost (root) frame — which is also why it doubles as the `parent` a nested cursor reports. */
interface ReplayFrame {
  flow: Graph;
  useNodeId?: NodeId;
  current: NodeId;
  currentInput: unknown;
  // The edge-resolved prompt (if any) that led to `current` — what a `use`
  // node reached next would seed its subgraph with. Mirrors driveGraph's
  // own `reason` variable, reconstructed the same way from replay.
  reason?: Message | undefined;
}

/** Where a fresh replay of `runtime.store`'s committed events left off: the frame stack — outermost flow first, innermost active `use` descent last — plus the thread they all share (a `use` node's subgraph never forks it) and any pending fan-out join inputs. */
interface ReplayPosition {
  thread: Thread;
  frames: ReplayFrame[];
  // Set only when replay landed on a join node whose fan-out group just
  // folded (every branch reported) — one entry per branch, in declared
  // order, mirroring driveStepEmit's own `pendingInputs`. Fan-out is only
  // ever reconstructed at the outermost frame — see `advanceFanOutGroup`.
  pendingInputs?: unknown[];
}

/** What a fresh replay of `runtime.store` left off at: mid-flight on one line (`single`), or spread across an in-flight fan-out group's branches (`fanout`). */
type ReplayResult = ({ kind: "single" } & ReplayPosition) | { kind: "fanout"; group: FanOutGroup };

/**
 * Reconstructs `tick`'s position purely from `runtime.store.events()` — no
 * state survives anywhere else. Starts at `flow.entry` with a fresh thread
 * when the log is empty, then replays every committed `output` (a step ran;
 * follow the edge its value selects, same as `advance`) and `message` (a
 * `waitFor` consumed one, or a `use` node's subgraph was seeded; follow *its*
 * edge, or descend into it, the same way) event in order, landing exactly
 * where the last tick call left off. A fan-out node's own output event
 * switches this into per-branch reconstruction (`FanOutGroup`) until either
 * every branch has reported (folding back to a single position at the join
 * node, `pendingInputs` set) or the join node's own output event shows the
 * fold already ran on an earlier tick call — the log-level signal to resume
 * ordinary single-line replay from there. Fan-out is only ever reconstructed
 * at the outermost frame — a fan-out inside a used subgraph is
 * notImplemented, matching tick()'s own live handling.
 *
 * A `use` node's subgraph shares its parent's thread (never forked), so
 * thread identity says nothing about whether a given event belongs to the
 * outer flow or a nested descent — only the event's own node id does. Every
 * node across every graph gets a globally unique id (see flow/graph.ts's
 * `freshNodeId`), so an output event's `stepId` belongs to exactly one
 * frame; the frame stack mirrors the `use` descents a live tick() call would
 * have made: pushed the moment a `message` event seeds a `use` node's
 * subgraph, popped the moment an output event turns up whose id belongs to
 * an enclosing frame instead — the completion event `commitOutput` tags with
 * the `use` node's own (outer) id once its subgraph reaches `finish`.
 */
function replayPosition(flow: Graph, runtime: Runtime): ReplayResult {
  let thread: Thread = { id: freshThreadId(runtime), messages: [], history: [] };
  let group: FanOutGroup | undefined;
  const frames: ReplayFrame[] = [{ flow, current: flow.entry, currentInput: undefined }];
  const root = frames[0];
  if (!root) unreachable("replayPosition: frame stack starts empty");

  for (const envelope of runtime.store.events()) {
    if (envelope.form !== "committed") continue;

    if (group) {
      if (envelope.type === "output") {
        const { value } = envelope.event as Event["output"];
        const stepId = envelope.stepId as NodeId;
        if (stepId === group.joinNodeId) {
          // The join already ran on an earlier tick call: the group folded
          // in the log itself. Resume ordinary single-line replay from here.
          thread = group.mainThread;
          const routed = route(flow.edges, stepId, value, thread, runtime);
          thread = routed.thread;
          root.current = routed.to;
          root.currentInput = routed.input;
          root.reason = routed.reason;
          group = undefined;
        } else {
          replayBranchOutput(group, envelope.threadId, stepId, value, flow);
        }
      }
      // toolCall/toolResult/compaction/invalidation/error/message inside a
      // branch aren't produced by any node kind `runBranchNode` supports —
      // out of scope for this slice's replay, same as the single-line path.
      continue;
    }

    if (envelope.threadId) thread = { ...thread, id: envelope.threadId };

    if (envelope.type === "output") {
      const { value } = envelope.event as Event["output"];
      const stepId = envelope.stepId as NodeId;

      // Find the frame that actually owns this node id, from the innermost
      // frame outward. Node ids are globally unique per graph, so exactly
      // one frame ever recognizes a given id; landing on an ENCLOSING
      // frame's own id (rather than the innermost one's) means every frame
      // above it already reached its own `finish` — each logged its own
      // such completion event first — so truncating the stack back to that
      // depth is simply catching up on pops a live tick() call already made.
      let owner: ReplayFrame | undefined;
      let depth = frames.length - 1;
      for (; depth >= 0; depth -= 1) {
        const candidate = frames[depth];
        if (candidate?.flow.nodes.has(stepId)) {
          owner = candidate;
          break;
        }
      }
      if (!owner) continue; // inner noise no known frame owns — skip
      frames.length = depth + 1;
      const top = owner;

      const branchTargets = thenEdges(top.flow.edges, stepId).map((edge) => edge.to);
      if (branchTargets.length > 1) {
        if (depth > 0) notImplemented("tick: fan-out inside a used subgraph");
        // A fan-out node's own output: hand off to per-branch reconstruction
        // instead of `advance`, which would silently pick just the first
        // branch (see `selectEdge`) and desync from what actually ran.
        group = buildFanOutGroup(branchTargets, stepId, top.flow, thread, value);
        continue;
      }

      const routed = route(top.flow.edges, stepId, value, thread, runtime);
      thread = routed.thread;
      top.current = routed.to;
      top.currentInput = routed.input;
      top.reason = routed.reason;
      continue;
    }

    if (envelope.type === "message") {
      const { message } = envelope.event as Event["message"];
      const top = frames[frames.length - 1];
      if (!top) unreachable("replayPosition: frame stack is empty");
      const node = top.flow.nodes.get(top.current);

      if (node?.kind === "waitFor") {
        pushMessage(thread, message);
        const routed = route(top.flow.edges, top.current, message, thread, runtime);
        thread = routed.thread;
        top.current = routed.to;
        top.currentInput = { ok: true } satisfies WaitForResult;
        top.reason = routed.reason;
        continue;
      }

      if (node?.kind === "use") {
        // Entering this use node's subgraph: mirrors driveUseNode's own seed
        // dedup (a "same"-threadAction reaching edge already pushed this
        // message onto the thread; this event just echoes it into the log)
        // and descends a frame at the subgraph's own entry, seeded with this
        // exact message — the same value `driveGraph`'s own `input`
        // parameter would carry.
        if (!top.reason) pushMessage(thread, message);
        frames.push({
          flow: node.subgraph,
          useNodeId: top.current,
          current: node.subgraph.entry,
          currentInput: message,
        });
        continue;
      }

      // Belongs to a node this replay isn't tracking as any frame's
      // `current` — safe to skip; it never needs to move a frame's position.
      continue;
    }
    // toolCall/toolResult/compaction/invalidation/error don't move the main
    // position on their own — out of scope for this slice's replay.
  }

  if (group) {
    const folded = foldGroup(group);
    if (folded) {
      return {
        kind: "single",
        thread: group.mainThread,
        frames: [{ flow, current: folded.current, currentInput: undefined }],
        pendingInputs: folded.pendingInputs,
      };
    }
    return { kind: "fanout", group };
  }

  return { kind: "single", thread, frames };
}

/** One frame of tick()'s live execution — same shape as a `ReplayFrame`, plus what only matters while actually running: this frame's own armed interrupts (recomputed per level, same as `driveGraph` does for every nested `driveGraph` call) and the `StepContext` its own nodes run with. */
interface LiveFrame {
  flow: Graph;
  useNodeId?: NodeId;
  interrupts: InterruptNode[];
  current: NodeId;
  currentInput: unknown;
  reason?: Message | undefined;
  context: StepContext;
}

/** Builds a `LiveFrame` from a replayed one, wiring its `StepContext` to read this exact frame's own (mutable) `current` through a closure over a holder cell — shared by the frame's own `current` accessor and `buildDriveContext`, so a later push/pop only ever touches the frame objects themselves, never anything `buildDriveContext` captured, and the frame is built complete and correctly-typed in one step (no incomplete-object cast). */
function buildLiveFrame(
  replayFrame: ReplayFrame,
  runtime: Runtime,
  getThread: () => Thread,
): LiveFrame {
  const holder = { current: replayFrame.current };
  return {
    flow: replayFrame.flow,
    ...(replayFrame.useNodeId !== undefined ? { useNodeId: replayFrame.useNodeId } : {}),
    interrupts: findInterruptNodes(replayFrame.flow),
    get current() {
      return holder.current;
    },
    set current(value: NodeId) {
      holder.current = value;
    },
    currentInput: replayFrame.currentInput,
    ...(replayFrame.reason !== undefined ? { reason: replayFrame.reason } : {}),
    context: buildDriveContext(replayFrame.flow, runtime, () => holder.current, getThread),
  };
}

/**
 * Advances a flow exactly one node, reconstructing where it is purely from
 * `runtime.store` — no state may survive in a JS closure between calls, so a
 * fresh `Runtime` object (same store) resumes exactly like the original one.
 *
 * A `waitFor` that already has a matching message waiting is “free”: it’s
 * consumed and its edge followed inline, without counting as this tick’s one
 * step — so resuming at a `waitFor` and reaching `finish` in the same call
 * (no work left to run in between) reports `done`, not `advanced`.
 *
 * A fan-out node's branches advance one at a time across separate `tick`
 * calls instead of running every branch to completion in one `Promise.all`
 * like `runFlow` does — see `advanceFanOutGroup`.
 *
 * A `use` node is driven the same way tick() drives its own top-level graph:
 * one node at a time, on a child frame pushed onto a stack (not forked —
 * `use` shares its parent's thread, unlike a fan-out branch). Reaching the
 * subgraph's own `finish` pops that frame and folds its result into the
 * enclosing one, exactly like `driveUseNode`'s own tail; parking on the
 * subgraph's own `waitFor` reports a cursor whose `parent` is the `use`
 * node's id, mirroring how a fan-out branch's cursor reports the fan-out
 * node as its parent.
 */
export async function tick(flow: Graph, runtime: Runtime): Promise<TickOutcome> {
  const attemptsByNode = new Map<NodeId, number>();
  const position = replayPosition(flow, runtime);

  if (position.kind === "fanout") {
    return advanceFanOutGroup(position.group, flow, runtime, attemptsByNode);
  }

  let currentThread: Thread = position.thread;
  let pendingInputs: unknown[] | undefined = position.pendingInputs;
  let ranStep = false;

  const getThread = (): Thread => currentThread;
  const frames: LiveFrame[] = position.frames.map((replayFrame) =>
    buildLiveFrame(replayFrame, runtime, getThread),
  );

  for (;;) {
    const frame = frames[frames.length - 1];
    if (!frame) unreachable("tick: frame stack is empty");
    const node = frame.flow.nodes.get(frame.current);
    if (!node) throw new Error(`graph "${frame.flow.name}" has no node "${frame.current}"`);
    const parent = frame.useNodeId !== undefined ? { parent: frame.useNodeId } : {};

    if (node.kind === "finish") {
      if (frames.length === 1) {
        return [{ node: frame.current, status: "done", result: frame.currentInput }];
      }
      // Pop: fold this frame's terminal value back into the enclosing one,
      // exactly like driveUseNode's own tail — a single output event tagged
      // with the *outer* use node's id, then follow its edge.
      const finished = frame;
      frames.pop();
      const below = frames[frames.length - 1];
      const useNodeId = finished.useNodeId;
      if (!below || useNodeId === undefined)
        unreachable("tick: popped frame missing its enclosing use-node id");
      const routed = commitRoute(
        runtime,
        currentThread.id,
        below.flow.edges,
        useNodeId,
        finished.currentInput,
        stepIdentity(useNodeId),
        currentThread,
      );
      currentThread = routed.thread;
      below.current = routed.to;
      below.currentInput = routed.input;
      below.reason = routed.reason;
      continue;
    }

    if (node.kind === "waitFor") {
      if (ranStep) return [{ node: frame.current, status: "active", ...parent }];
      const kinds = [
        node.messageKind,
        ...frame.interrupts.map((interrupt) => interrupt.messageKind),
      ];
      const message = runtime.store.consume(
        (candidate) => candidate.kind !== undefined && kinds.includes(candidate.kind),
      );
      if (!message)
        return [{ node: frame.current, status: "parked", waitingFor: kinds, ...parent }];

      runtime.store.append({ message }, { type: "message", threadId: currentThread.id });
      pushMessage(currentThread, message);

      const interrupt = frame.interrupts.find(
        (candidate) => candidate.messageKind === message.kind,
      );
      if (interrupt) {
        const stepContext: StepContext = { ...frame.context, inputs: [message] };
        const emit = await runStep(interrupt.run, stepContext);
        if (!("output" in emit)) notImplemented(`emit "${Object.keys(emit).join(", ")}"`);
        const routed = commitRoute(
          runtime,
          currentThread.id,
          frame.flow.edges,
          interrupt.id,
          emit.output,
          { stepId: interrupt.id },
          currentThread,
        );
        currentThread = routed.thread;
        frame.current = routed.to;
        frame.currentInput = routed.input;
        ranStep = true;
        frame.reason = routed.reason;
      } else {
        const routed = route(frame.flow.edges, frame.current, message, currentThread, runtime);
        currentThread = routed.thread;
        frame.current = routed.to;
        frame.currentInput = { ok: true } satisfies WaitForResult;
        frame.reason = routed.reason;
      }
      continue;
    }

    if (node.kind === "use") {
      if (ranStep) return [{ node: frame.current, status: "active", ...parent }];

      // The subgraph's initial prompt — same seed rule as driveUseNode's own
      // (the reaching edge's prompt, a real Message reaching this node
      // directly, or the thread's last message as fallback) — logged once
      // here the same way regardless of which of those it came from.
      const fallback: Message | undefined = currentThread.messages.at(-1);
      const seed: Message | undefined =
        frame.reason ?? (looksLikeMessage(frame.currentInput) ? frame.currentInput : fallback);
      if (!seed) throw new Error("use node has no message to seed its subgraph with");
      if (!frame.reason) pushMessage(currentThread, seed);
      runtime.store.append({ message: seed }, { type: "message", threadId: currentThread.id });

      frames.push(
        buildLiveFrame(
          {
            flow: node.subgraph,
            useNodeId: frame.current,
            current: node.subgraph.entry,
            currentInput: seed,
          },
          runtime,
          getThread,
        ),
      );
      continue;
    }

    if (node.kind !== "step") notImplemented(`tick: node kind "${node.kind}"`);

    if (ranStep) return [{ node: frame.current, status: "active", ...parent }];

    if (node.label) currentThread = { ...currentThread, label: node.label };

    const inputs = pendingInputs ?? [frame.currentInput];
    pendingInputs = undefined;

    // Validate JoinStep tagging the same way driveGraph does for runFlow —
    // see assertJoinTagging.
    assertJoinTagging(frame.current, node.run, inputs);

    const stepContext: StepContext = { ...frame.context, inputs };
    const emit = await runStep(node.run, stepContext);

    if ("output" in emit) {
      const branchTargets = thenEdges(frame.flow.edges, frame.current).map((edge) => edge.to);
      if (branchTargets.length > 1) {
        // Same detection driveStepEmit uses, but tick spawns per-branch
        // cursors instead of running every branch to completion in one
        // Promise.all — see advanceFanOutGroup. Only ever reconstructed at
        // the outermost frame — see replayPosition's own matching guard.
        if (frames.length > 1) notImplemented("tick: fan-out inside a used subgraph");
        appendOutput(
          runtime,
          currentThread.id,
          emit.output,
          stepIdentity(frame.current, node.label),
        );
        const group: FanOutGroup = buildFanOutGroup(
          branchTargets,
          frame.current,
          frame.flow,
          currentThread,
          emit.output,
        );
        return group.branches.map((branch) => branchCursorState(branch, group));
      }
    }

    const outcome = await driveStepEmit(
      emit,
      node,
      frame.current,
      currentThread,
      frame.flow,
      runtime,
      attemptsByNode,
    );

    if (outcome.kind === "retry") continue;
    if (outcome.pendingInputs)
      unreachable("tick: driveStepEmit reported a fan-out after tick's own check ruled it out");

    currentThread = outcome.thread;
    frame.currentInput = outcome.input;
    frame.reason = outcome.reason;
    frame.current = outcome.to;
    ranStep = true;
  }
}

/** Calls `tick` until it stops advancing — every cursor either parked or done. */
export async function tickUntilSuspended(flow: Graph, runtime: Runtime): Promise<TickOutcome> {
  for (;;) {
    const outcome = await tick(flow, runtime);
    if (outcome.every((cursor) => cursor.status !== "active")) return outcome;
  }
}
