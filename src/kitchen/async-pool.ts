/**
 * Bounded fan-out for index-ordered async work (admit/ack/store I/O).
 *
 * If `fn` rejects for one item, `Promise.all` rejects immediately while other
 * in-flight workers may still finish (and consume further indices). Callers
 * that mutate durable state must rely on CAS / idempotency — not all-or-nothing
 * mapPool semantics.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await fn(items[index]!, index);
      }
    }),
  );
  return results;
}
