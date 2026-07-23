// Errors raised by the src/testing/ step-primitives helpers.

/** Raised by `stepUntil` when it can't reach the caller's condition. */
export class StepUntilError extends Error {
  constructor(
    public readonly reason: "stalled" | "budget-exceeded",
    message: string,
  ) {
    super(message);
    this.name = "StepUntilError";
  }
}
