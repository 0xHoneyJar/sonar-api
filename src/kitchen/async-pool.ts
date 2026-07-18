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
  const settled = new Array<{ ok: true; value: R } | { ok: false; error: unknown }>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        try {
          settled[index] = { ok: true, value: await fn(items[index]!, index) };
        } catch (error) {
          settled[index] = { ok: false, error };
        }
      }
    }),
  );
  const firstError = settled.find((row) => row.ok === false);
  if (firstError && firstError.ok === false) throw firstError.error;
  return settled.map((row) => {
    if (row.ok !== true) {
      throw new Error("mapPool: internal hole after successful drain");
    }
    return row.value;
  });
}
