/**
 * Abort / deadline guards shared by the EVM probe adapter.
 */
export const isAborted = (abort: AbortSignal): boolean => abort.aborted;

export const isPastDeadline = (nowMs: number, deadlineAtMs: number): boolean =>
  nowMs >= deadlineAtMs;

export const abortOrDeadline = (input: {
  readonly abort: AbortSignal;
  readonly deadline_at_ms: number;
  readonly now_ms: number;
}): "aborted" | "deadline" | undefined => {
  if (isAborted(input.abort)) return "aborted";
  if (isPastDeadline(input.now_ms, input.deadline_at_ms)) return "deadline";
  return undefined;
};
