---
title: "Intelligence-Router Coherence — cheval ⇄ /compose ⇄ FAGAN/flatline"
date: 2026-06-03
mode: ARCH (coherence audit) · multimodal-grounded
status: rfc
trust_tier: ai-derived
provenance:
  source_type: ai-derived
  extracted_by: "setup-coherence grounding (wf_a24f5f2d, 6 readers) + live cheval dogfood (Session 8 meta-reflection)"
---

# Intelligence-Router Coherence

> Why the review experience felt flaky: the agent was **improvising** the multimodal
> gate (hand-rolled Claude-only workflows, then `fagan-panel.sh` run by hand because the
> construct wasn't even installed) instead of the Loa harness providing it **through
> cheval**. This RFC makes the gate STRUCTURAL and routes it through the intelligence router.

## 1. The coherence map (grounded)

| Layer | What it is | Routes through cheval? |
|---|---|---|
| **cheval** (`.claude/adapters/cheval.py`) | the intelligence router: chain-walk fallback · MODELINV audit · verdict-quality · metering · redaction · capability gate | — (it IS the router) |
| **flatline-orchestrator** | planning-doc multimodal review (PRD/SDD/Sprint) | ✅ `call_model` → cheval |
| **construct-fagan** (`fagan-panel.sh`) | code-review council (opus/codex/cursor) | ❌ **direct CLI** (`*_exec_single`) — bypasses cheval |
| **compositions** (`code-implement-and-review.yaml` …) | declare `codex-review`/FAGAN as the review stage | ❌ no composition routes through cheval |
| **/compose** (rooms-substrate Form C) | runs EVERY stage as a single Claude `agent()` | ❌ `persona:FAGAN` gate = single Claude, no council |
| **kickoff** | hands off WHAT + the composition loop | ❌ no `stakes-tier`, no review-cadence, no cheval hook |

**Net:** compositions *declare* adversarial review; the runtime delivers single-Claude. The
only real multimodal council (`fagan-panel.sh`) is CLI-direct and audit-blind (codex/cursor
report `model_ran: "unknown"`). Nothing links `surface_class` to a mandatory gate.

## 2. The load-bearing insight (why "just route FAGAN through cheval" is subtle)

cheval has **two transport classes**:

- **HTTP providers** (openai/anthropic/google API) — need API keys **+ live quota**. In this
  environment OpenAI returns `insufficient_quota`. *This is why FAGAN went CLI-direct.*
- **Headless adapters** (`codex-headless` / `claude-headless` / `gemini-headless`) — wrap the
  **same subscription-auth CLIs** FAGAN already uses, but ADD the audit envelope.

➡ **The coherent path: route review voices through cheval bound to HEADLESS adapters.** You
keep subscription auth (no quota dependency) AND gain MODELINV + verdict-quality + chain-walk.

## 3. Proof — `cheval-council.sh` dogfood (live, this session)

New primitive `construct-fagan/scripts/cheval-council.sh` (cheval-routed sibling of
`fagan-panel.sh`). Run on a financial-bug diff (unguarded `balance - amount` underflow),
3 voices:

```
verdict CHANGES_REQUIRED · 3 voices survived, 0 dropped
  deep-thinker   → google:gemini-headless   CHANGES_REQUIRED
  gpt-reviewer   → openai:codex-headless     CHANGES_REQUIRED   ← chain-walked!
  reviewing-code → openai:codex-headless     CHANGES_REQUIRED
3 × MODELINV envelopes emitted (transport: cli)
```

The decisive line: `gpt-reviewer` was *requested* as openai-HTTP (quota-dead) and cheval
**chain-walked it to `openai:codex-headless`** (the CLI) — recording the real `model_ran`. A
direct-CLI FAGAN cannot do that; it would have dropped the voice. **That fallback is the
entire argument for routing the council through the router.**

## 4. The doctrine (make it structural, not a choice)

> Medium-high-stakes work — **financial risk · data validity · auth/contract surface** — MUST
> route its review through the **cheval-routed multimodal council**. Single-model review (even
> multi-Claude-subagent) shares one corpus's blind spots. This session is Exhibit A: the
> council caught bugs in the agent's OWN fixes — twice (the `owns()` `instanceof` dead-code,
> the verify block-skew → spurious-refuted). Rigor cannot depend on an agent *choosing* it.

Stakes vocabulary (extends `surface_class`): `financial` · `data-validity` · `auth-contract`
⇒ **mandatory** cheval-council gate · `cosmetic` · `reversible` ⇒ inline review OK.

## 5. What shipped this session

- ✅ `construct-fagan/scripts/cheval-council.sh` — the working, dogfooded primitive.
- ✅ `code-implement-and-review.yaml` — `review_routing` mandates cheval-council on high-stakes;
  `data-validity` tier added; stale `codex-rescue` MCP → `codex` CLI.
- ✅ `audit-setup-coherence.yaml` — a /compose composition that audits this very coherence,
  multimodal-gated (the self-referential gate).
- ✅ kickoff template — `stakes-tier` intake + a declared **Review Cadence** + cheval detection.

## 6. Spec'd for focused follow-up (deeper runtime changes)

1. **`/compose` segment-emitter routing** — add a stage-schema field
   `routing: { kind: native|cheval, voices: [...] }`; the Form C compiler detects
   `role:craft-gate`/`persona:FAGAN` and, on a high-stakes `surface_class`, emits a
   cheval-council dispatch instead of a bare `agent()`. (rooms-substrate `segment-emitter.py`.)
2. **construct-fagan voice libs → cheval** — `lib-{claude,codex,cursor}-exec.sh` call
   `cheval.py --agent <voice-binding>` (headless) instead of the raw CLI, so the canonical
   panel inherits the audit envelope. Keep a `--mode cli-direct` escape hatch.
3. **cheval fagan-voice bindings** — add `gpt-reviewer-fagan`/`opus-reviewer-fagan`/
   `composer-reviewer-fagan` agents bound to headless adapters with fallback chains.
4. **codex-rescue ghost** — `lib-curl-fallback.sh:127` is a stale log-redaction example only
   (harmless); the real staleness is the composition `depends_on: codex-rescue` (the MCP),
   now repointed to the `codex` CLI.

## 7. The canonical cheval-consumer contract (mirror `flatline call_model`)

```bash
LOA_VERDICT_QUALITY_SIDECAR="$vq" \
  python3 .claude/adapters/cheval.py \
    --agent <voice> --input <diff> --system <persona> \
    --output-format json --json-errors --max-tokens N --timeout SEC
# stdout: {content, model, provider, usage, latency_ms}
# .run/model-invoke.jsonl: MODELINV envelope (final_model_id, transport, chain walk, cost)
# $vq: verdict-quality {consensus_outcome, voices_dropped, chain_health, status}
# exit: 0 ok · 6 budget · 11 no-adapter · 12 chain-exhausted
```
Bind voices to **headless** agents (subscription auth) unless API quota is provisioned.
