// Systems running flows — satisfiesPersonas / satisfiesFlows. See docs/reference.md.

import type { Profile } from "../flow/profile.js";
import type { Model, ReasoningLevel } from "../flow/model.js";
import type { Graph } from "../flow/graph.js";
import type { Binding, Tool, Toolset } from "../flow/tool.js";
import type { AssistantMessage } from "../flow/message.js";
import { userText } from "../flow/message.js";
import type { ModelPort } from "./model-port.js";
import type { Runtime } from "./runtime.js";
import { runFlow } from "./runtime.js";
import { memoryStore } from "../adapters/stores/memory.js";

/** Everything a persona needs that is not provided. Empty means ready. */
export type Missing =
  | { kind: "model"; model: string }
  | { kind: "tool"; model: string; tool: string }
  | { kind: "reasoning"; model: string; level: ReasoningLevel };

/** Whether some binding backs a tool or toolset reference, by name. */
function isBound(ref: Tool | Toolset, bindings: Binding[]): boolean {
  return bindings.some(
    (binding) =>
      (binding.kind === "tool" && binding.tool.name === ref.name) ||
      (binding.kind === "toolset" && binding.toolset.name === ref.name),
  );
}

/** Checks each persona directly: does it have a model port, its tools, its reasoning level? */
export function satisfiesPersonas(
  personas: Profile[],
  models: (model: Model) => ModelPort | undefined,
  bindings: Binding[],
): Missing[] {
  const missing: Missing[] = [];

  for (const persona of personas) {
    const model = persona.model.identifier;

    if (!models(persona.model)) missing.push({ kind: "model", model });

    for (const ref of persona.tools) {
      if (!isBound(ref, bindings)) missing.push({ kind: "tool", model, tool: ref.name });
    }

    if (persona.reasoning && !persona.model.reasoning.includes(persona.reasoning)) {
      missing.push({ kind: "reasoning", model, level: persona.reasoning });
    }
  }

  return missing;
}

/** A harmless reply that lets a probed step's `modelCall` complete and the graph continue. */
function cannedReply(model: Model): AssistantMessage {
  return {
    role: "assistant",
    provider: "coverage-probe",
    model: model.identifier,
    content: [],
    usage: { input: 0, output: 0 },
  };
}

/**
 * A `ModelPort` that never calls a real model: it inspects the full `Profile`
 * it's asked to respond with — using `satisfiesPersonas` so the two functions
 * share one place that knows what "missing" means for a persona — records
 * whatever's missing, and resolves with a canned reply.
 */
function probePort(
  model: Model,
  models: (model: Model) => ModelPort | undefined,
  bindings: Binding[],
  record: (found: Missing[]) => void,
): ModelPort {
  return {
    model,
    respond(profile) {
      record(satisfiesPersonas([profile], models, bindings));
      return Promise.resolve(cannedReply(model));
    },
  };
}

/**
 * Finds every `Profile` reachable before a flow's *first* real suspension.
 * A step is a plain closure — nothing about a graph's structure says which
 * profiles it uses — so the only way to find out is to run it, with every
 * model swapped for a probe that inspects the profile it's handed instead of
 * calling anywhere real. This function returns synchronously (matching how
 * callers use it — no `await`), which bounds what it can discover: a probed
 * `modelCall` records its profile synchronously, before `runFlow`'s own first
 * `await`, but anything after that first suspension — a second step, a second
 * `modelCall` — only runs as a later microtask, once this function has
 * already returned. Coverage-checking a flow whose persona-using steps come
 * after its first suspension point needs a different, `await`-based design.
 */
export function satisfiesFlows(
  flows: Graph[],
  models: (model: Model) => ModelPort | undefined,
  bindings: Binding[],
): Missing[] {
  const missing = new Map<string, Missing>();
  const record = (found: Missing[]): void => {
    for (const entry of found) missing.set(JSON.stringify(entry), entry);
  };

  for (const flow of flows) {
    const runtime: Runtime = {
      models: (model) => probePort(model, models, bindings, record),
      bindings,
      store: memoryStore(),
      errorHandlers: [],
    };

    // Not awaited, to match satisfiesFlows' own synchronous contract. This
    // only sees the first modelCall reachable before runFlow's first real
    // suspension — see the function's doc comment above for why.
    runFlow(flow, userText("coverage check"), runtime).catch(() => undefined);
  }

  return [...missing.values()];
}
