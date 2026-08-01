// Public package entry point.
//
// `@behalf-js/core` is the engine plus the ai extension: it re-exports
// `@behalf-js/engine`'s whole surface unchanged, so a consumer importing
// `defineGraph`/`runtime`/`driveFlow` from here sees exactly what it always
// did, and adds `ai/` on top (models, tools, threads, agentTurn). An
// engine-only consumer — a durable workflow with no AI in it — depends on
// `@behalf-js/engine` directly and never pulls this in.

export * from "@behalf-js/engine";
export * from "./ai/index.js";
