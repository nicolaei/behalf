// The Learn "Tools and handlers" page's example: a tool declaration, its
// handler, and both a direct (provide) and toolset (expand) binding.
// search-tool.test.ts drives both bindings through a real agentTurn, with a
// scripted ModelPort that calls the tool once before finishing.

import { tool, toolset, provide, expand } from "@behalf-js/core";
import type { ToolHandler, Binding } from "@behalf-js/core";

const knowledgeBase = [
  "Reset your password from the account settings page.",
  "Invoices are issued on the first of each month.",
  "Refunds take three to five business days to appear.",
];

// #region tool
export const search = tool<{ query: string }, { hits: string[] }>(
  "search",
  "Search the internal knowledge base for articles matching a query.",
);
// #endregion tool

// #region handler
export const searchHandler: ToolHandler<{ query: string }, { hits: string[] }> = (
  { query },
  context,
) => {
  // context.correlationId ties this call to its own toolCall/toolResult pair in the
  // log, in case a handler needs a key to check whether it already ran on resume.
  void context.correlationId;
  const hits = knowledgeBase.filter((article) =>
    article.toLowerCase().includes(query.toLowerCase()),
  );
  return Promise.resolve({ hits });
};
// #endregion handler

// #region binding
export const searchBinding: Binding = provide(search, searchHandler);

const supportBundle = toolset("support-bundle", "Curated support tools, expanded at runtime.");
export const supportBundleBinding: Binding = expand(supportBundle, () =>
  Promise.resolve({ search: searchHandler as ToolHandler }),
);
// #endregion binding

export { supportBundle };
