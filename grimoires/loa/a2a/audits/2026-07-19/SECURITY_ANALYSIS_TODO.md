# Security Analysis TODO

**Audit ID:** `audit-2026-07-19-sprint-1`
**Schema Version:** 1.0
**Scope:** Sprint 1 changed application surface (`src/truth-contract/`, 1,446 lines)

## Flagged Sources (Pass 1)

| ID | File:Line | Type | Trust | Description | Status |
|---|---|---|---|---|---|
| SRC-001 | `src/truth-contract/bundle-compiler.ts:162` | unknown object | UNTRUSTED | Unsigned root compilation input | SAFE |
| SRC-002 | `src/truth-contract/bundle-compiler.ts:320` | wire bytes | UNTRUSTED | Signed root verification input | SAFE |
| SRC-003 | `src/truth-contract/normative-compiler.ts:277` | unknown object | UNTRUSTED | Normative policy object | SAFE |
| SRC-004 | `scripts/verify-truth-traceability.ts:12` | fixed local file | TRUSTED LOCAL | Beads ownership ledger | SAFE |

## Flagged Sinks (Pass 1)

| ID | File:Line | Type | Risk | Status |
|---|---|---|---|---|
| SINK-001 | `src/truth-contract/crypto.ts:29` | Ed25519 signer | Unauthorized signing | SAFE |
| SINK-002 | `src/truth-contract/canonical.ts:43` | JCS/hash primitive | Ambiguous or cyclic canonicalization | SAFE |
| SINK-003 | `scripts/verify-truth-traceability.ts:12` | file read | Path traversal | SAFE |

## Taint Paths (Pass 2)

| ID | Source | Sink | Hops | Sanitized | Status |
|---|---|---|---|---|---|
| PATH-001 | SRC-001 | SINK-001 | acyclic preflight → strict schema → closed semantic checks → issuer-key binding → domain signing | YES | SAFE |
| PATH-002 | SRC-002 | SINK-002 | 256 KiB ceiling → fatal UTF-8 → canonical JSON equality → strict schema → hash/signature verification | YES | SAFE |
| PATH-003 | SRC-003 | SINK-002 | acyclic preflight → strict tagged union → semantic totals → 4 MiB object limit → JCS/hash | YES | SAFE |
| PATH-004 | SRC-004 | SINK-003 | fixed repository-relative path, no caller-controlled path component | YES | SAFE |

## Cross-Request Flows

None. Sprint 1 adds no route, request handler, database, cache, registry, or
network publication path.
