// Tiny pub/sub bridging the UI to the `ask` tool's own binding. The binding
// (wired in index.tsx) calls `askBridge.ask(question)` and awaits the
// returned promise; the UI subscribes to see the pending question and,
// on submit, calls the pending `resolve(answer)` itself — no `ready.store`
// traffic involved, this never goes through `waitFor(userInput)`.

export type PendingAsk = { question: string; resolve: (answer: string) => void };

export interface AskBridge {
  ask(question: string): Promise<{ answer: string }>;
  subscribe(listener: (pending: PendingAsk | null) => void): () => void; // null = answered/cleared
}

export function createAskBridge(): AskBridge {
  const listeners = new Set<(pending: PendingAsk | null) => void>();

  function notify(pending: PendingAsk | null): void {
    for (const listener of listeners) listener(pending);
  }

  return {
    ask(question: string): Promise<{ answer: string }> {
      return new Promise((resolve) => {
        const pending: PendingAsk = {
          question,
          resolve: (answer: string) => {
            resolve({ answer });
            notify(null);
          },
        };
        notify(pending);
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
