// AI authoring — public barrel. Messages, models, tools, and agentTurn.

export type {
  ContentBlock,
  Intent,
  MessageKind,
  Message,
  UserMessage,
  AssistantMessage,
  Usage,
} from "./message.js";
export { userText } from "./message.js";
export type { ReasoningLevel, Model } from "./model.js";
export type { Tool, Toolset, ToolContext, ToolHandler, Binding } from "./tool.js";
export { tool, toolset, provide, expand } from "./tool.js";
export type { Profile } from "./profile.js";
export { agentTurn } from "./agent-turn.js";
export type {
  FinishOn,
  AgentTurnOptions,
  AgentTurnCompactOptions,
  AgentTurnResult,
} from "./agent-turn.js";
export type { ModelPort } from "./model-port.js";
