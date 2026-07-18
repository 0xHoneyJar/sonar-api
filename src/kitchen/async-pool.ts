/**
 * Bounded fan-out for index-ordered async work (admit/ack/store I/O).
 *
 * Workers are not cancelled on the first failure: in-flight (and further)
 * items may still run to completion. After the pool drains, the first error
 * is rethrown. Callers that mutate durable state must rely on CAS /
 * idempotency — mapPool is not all-or-nothing.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (concurrency < 1) {
    throw new Error("mapPool: concurrency must be >= 1");
  }
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  let firstError: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        try {
          results[index] = await fn(items[index]!, index);
        } catch (error) {
          firstError ??= error;
        }
      }
    }),
  );
  if (firstError !== undefined) throw firstError;
  return results;
}
