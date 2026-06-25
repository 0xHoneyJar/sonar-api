import { describe, it, expect } from "vitest";
import { ensureKindConstraint, REQUIRED_KINDS } from "../src/svm/ensure-kind-constraint";

// Hasura run_sql returns a header row + data rows: [["pg_get_constraintdef"], ["CHECK (...)"]].
function mockRunner(constraintDef: string | null) {
  const calls: string[] = [];
  const runSql = async (sql: string): Promise<unknown[][]> => {
    calls.push(sql);
    if (sql.includes("pg_get_constraintdef")) {
      return constraintDef === null ? [["pg_get_constraintdef"]] : [["pg_get_constraintdef"], [constraintDef]];
    }
    return []; // ALTER returns no tuples
  };
  return { calls, runSql };
}

const WIDE = "CHECK ((kind = ANY (ARRAY['mint'::text, 'transfer'::text, 'burn'::text, 'sale'::text, 'list'::text, 'delist'::text])))";
const NARROW = "CHECK ((kind = ANY (ARRAY['mint'::text, 'transfer'::text, 'burn'::text, 'sale'::text])))";

describe("ensureKindConstraint (#85 — safe-by-construction cutover)", () => {
  it("no-ops when the live CHECK already permits all kinds (steady state = one SELECT)", async () => {
    const { calls, runSql } = mockRunner(WIDE);
    const r = await ensureKindConstraint({ runSql });
    expect(r.widened).toBe(false);
    expect(calls).toHaveLength(1); // SELECT only
    expect(calls.some((s) => s.includes("ALTER TABLE"))).toBe(false);
  });

  it("widens when list/delist are absent (the pre-cutover state) — atomic DROP+ADD with all kinds", async () => {
    const { calls, runSql } = mockRunner(NARROW);
    const r = await ensureKindConstraint({ runSql });
    expect(r.widened).toBe(true);
    const alter = calls.find((s) => s.includes("ALTER TABLE"));
    expect(alter).toBeDefined();
    expect(alter!).toContain("DROP CONSTRAINT IF EXISTS collection_event_kind_chk");
    expect(alter!).toContain("ADD CONSTRAINT collection_event_kind_chk");
    for (const k of REQUIRED_KINDS) expect(alter!).toContain(`'${k}'`);
  });

  it("widens when the constraint is absent entirely (fresh table → no data row)", async () => {
    const { calls, runSql } = mockRunner(null);
    const r = await ensureKindConstraint({ runSql });
    expect(r.widened).toBe(true);
    expect(calls.some((s) => s.includes("ADD CONSTRAINT"))).toBe(true);
  });

  it("substring-safety: a def with 'delist' but NOT 'list' is NOT treated as fully widened (FAGAN MINOR-3)", async () => {
    // the check keeps the leading quote ('list'), so 'delist' (…e-l-i-s-t') cannot satisfy it — must widen
    const onlyDelist = "CHECK ((kind = ANY (ARRAY['mint'::text, 'transfer'::text, 'burn'::text, 'sale'::text, 'delist'::text])))";
    const { calls, runSql } = mockRunner(onlyDelist);
    const r = await ensureKindConstraint({ runSql });
    expect(r.widened).toBe(true);
    expect(calls.some((s) => s.includes("ADD CONSTRAINT"))).toBe(true);
  });

  it("is idempotent — a second call after a widen is a no-op (DROP IF EXISTS tolerates re-run)", async () => {
    // first call widens (narrow), second sees wide → no-op
    let def = NARROW;
    const runSql = async (sql: string): Promise<unknown[][]> => {
      if (sql.includes("pg_get_constraintdef")) return [["pg_get_constraintdef"], [def]];
      def = WIDE; // the ALTER widened it
      return [];
    };
    expect((await ensureKindConstraint({ runSql })).widened).toBe(true);
    expect((await ensureKindConstraint({ runSql })).widened).toBe(false);
  });
});
