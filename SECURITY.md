# Security Policy

## Reporting a vulnerability

Email **jani@0xhoneyjar.xyz** — do not open a public issue. Include what you
found, how to reproduce it, and the impact you think it has. Expect a reply
within 48 hours.

## What this repo is

A read-only blockchain indexer. It holds no user data, takes no writes from
anyone, and authenticates nobody. It reads public chain data through Envio
HyperSync and serves the result over a public GraphQL endpoint that requires no
credentials, because everything in it is already public.

That shape rules most vulnerability classes out. What is actually in scope:

- **Secrets in the repo.** `ENVIO_API_TOKEN` is the only credential this repo
  needs. `.env` and `.env.*` are gitignored; `.env.example` is the only one
  tracked and it holds placeholders.
- **Correctness bugs with financial consequence.** A decoder that misattributes a
  sale, or a handler that credits the wrong wallet, feeds scoring downstream.
  Report these as security issues, not just bugs.
- **The public endpoint.** Rate limiting and query-cost limiting are whatever the
  host provides. The self-hosted Caddy gateway that did per-IP limiting and
  capped request bodies at 50KB was removed with the rest of the Railway stack
  (see MIGRATION.md), and nothing in this repo replaces it.

Out of scope: dependency CVEs with no exploit path here (report upstream),
social engineering, and denial of service against the public read endpoint.

## What runs automatically

`.github/workflows/secret-scanning.yml` — TruffleHog and GitLeaks, on every push
and PR plus a weekly full-history scan. Both report; neither blocks a merge,
because unverified pattern hits in documentation are common and blocking on them
trains people to ignore the check.

That is the only security automation. There is no Dependabot, no CodeQL, and no
branch protection configured in this repo — earlier versions of this file claimed
all three.

## Handling a leak

Rotate the credential at its provider **first**. Scrubbing git history does not
revoke a key, and any key pushed to GitHub should be assumed captured.
