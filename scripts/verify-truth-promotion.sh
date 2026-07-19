#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
ROOT="$DEFAULT_ROOT"
RECEIPT_REL="grimoires/loa/promotion-receipt.sonar-score-v1.json"

usage() {
  printf 'Usage: %s [--root PATH] [--receipt REPO_RELATIVE_PATH]\n' "$0"
}

fail() {
  local code="$1"
  local message="$2"
  jq -cn --arg code "$code" --arg message "$message" \
    '{schema:"sonar.truth-promotion-verification.v1",status:"FAIL",code:$code,message:$message}' >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --root)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      ROOT="$2"
      shift 2
      ;;
    --receipt)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      RECEIPT_REL="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

for command in git jq shasum yq; do
  command -v "$command" >/dev/null 2>&1 ||
    fail "MISSING_TOOL" "Required verifier tool is unavailable: $command"
done

ROOT="$(cd "$ROOT" 2>/dev/null && pwd -P)" ||
  fail "INVALID_ROOT" "Repository root does not exist"

case "$RECEIPT_REL" in
  /*|*".."*)
    fail "UNSAFE_RECEIPT_PATH" "Receipt path must be repository-relative without '..'"
    ;;
esac

RECEIPT="$ROOT/$RECEIPT_REL"
[[ -f "$RECEIPT" ]] ||
  fail "RECEIPT_MISSING" "Promotion receipt is missing"

git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  fail "NOT_GIT_REPOSITORY" "Promotion root is not a Git repository"

jq -e '
  .schema == "loa.operator-promotion-receipt.v1" and
  .repository == "0xHoneyJar/sonar-api" and
  .implementation_authorized == true and
  .attestation_kind == "self_attested_conversation_approval" and
  (.approved_by | startswith("operator:")) and
  (.approval_source | type == "string" and length > 0) and
  (.base_commit | test("^[0-9a-f]{40}$")) and
  (.flatline.sprint == "two_attempt_campaign_complete_post_review_remedies_integrated") and
  .production_invariants.ethereum_start_block == "12287507" and
  .production_invariants.envio_restart == "unset" and
  .production_invariants.floor_lowering == false and
  .production_invariants.wipe == false and
  .production_invariants.kf_013_replay == false and
  (.documents | keys | sort) == [
    "grimoires/loa/prd.md",
    "grimoires/loa/sdd.md",
    "grimoires/loa/sprint.md"
  ]
' "$RECEIPT" >/dev/null ||
  fail "RECEIPT_SCHEMA_INVALID" "Promotion receipt fields or invariants are invalid"

normalize_remote() {
  # Compare repositories by identity, not exact URL spelling. A local clone
  # yields "https://github.com/OWNER/REPO.git" while GitHub Actions checkout
  # yields "https://github.com/OWNER/REPO" (and SSH/token remotes add a
  # "user@" prefix or "host:owner" form). Reduce every variant to a
  # scheme-less "host/owner/repo" so the same approved repo matches in every
  # environment. This narrows nothing security-relevant: host/owner/repo is
  # the repository identity, so two different repos can never collide.
  local url="$1"
  url="${url%.git}"     # drop a trailing .git
  url="${url#*://}"     # drop the scheme (https:// / ssh://)
  url="${url##*@}"      # drop optional userinfo (user:token@ / git@)
  url="${url/:/\/}"     # ssh "host:owner" → "host/owner"
  printf '%s' "$url"
}

expected_remote="$(jq -r '.remote' "$RECEIPT")"
actual_remote="$(git -C "$ROOT" remote get-url origin 2>/dev/null)" ||
  fail "REMOTE_MISSING" "Git origin is unavailable"
[[ "$(normalize_remote "$actual_remote")" == "$(normalize_remote "$expected_remote")" ]] ||
  fail "REMOTE_MISMATCH" "Git origin does not match the approved repository"

base_commit="$(jq -r '.base_commit' "$RECEIPT")"
git -C "$ROOT" cat-file -e "${base_commit}^{commit}" 2>/dev/null ||
  fail "BASE_COMMIT_MISSING" "Approved base commit is unavailable"
git -C "$ROOT" merge-base --is-ancestor "$base_commit" HEAD ||
  fail "BASE_COMMIT_DIVERGED" "Approved base commit is not an ancestor of HEAD"

git -C "$ROOT" ls-files --error-unmatch "$RECEIPT_REL" >/dev/null 2>&1 ||
  fail "RECEIPT_UNTRACKED" "Promotion receipt is not committed"
git -C "$ROOT" diff --quiet -- "$RECEIPT_REL" &&
  git -C "$ROOT" diff --cached --quiet -- "$RECEIPT_REL" ||
  fail "RECEIPT_DIRTY" "Promotion receipt differs from the committed version"

if [[ -v ENVIO_RESTART ]]; then
  fail "ENVIO_RESTART_SET" "ENVIO_RESTART must remain unset"
fi

ethereum_floor="$(yq '.chains[] | select(.id == 1) | .start_block' "$ROOT/config.yaml")"
[[ "$ethereum_floor" == "12287507" ]] ||
  fail "ETHEREUM_FLOOR_MISMATCH" "Ethereum start_block must remain 12287507"

while IFS=$'\t' read -r relative_path expected_prefixed; do
  case "$relative_path" in
    /*|*".."*)
      fail "UNSAFE_DOCUMENT_PATH" "Approved document path is unsafe"
      ;;
  esac

  document="$ROOT/$relative_path"
  [[ -f "$document" ]] ||
    fail "DOCUMENT_MISSING" "Approved document is missing: $relative_path"
  git -C "$ROOT" ls-files --error-unmatch "$relative_path" >/dev/null 2>&1 ||
    fail "DOCUMENT_UNTRACKED" "Approved document is not committed: $relative_path"
  git -C "$ROOT" diff --quiet -- "$relative_path" &&
    git -C "$ROOT" diff --cached --quiet -- "$relative_path" ||
    fail "DOCUMENT_DIRTY" "Approved document differs from the committed version: $relative_path"

  expected="${expected_prefixed#sha256:}"
  [[ "$expected_prefixed" == "sha256:$expected" && "$expected" =~ ^[0-9a-f]{64}$ ]] ||
    fail "DIGEST_FORMAT_INVALID" "Approved digest has an invalid format: $relative_path"
  actual="$(shasum -a 256 "$document" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] ||
    fail "DIGEST_MISMATCH" "Approved digest does not match: $relative_path"

  committed="$(git -C "$ROOT" show "HEAD:$relative_path" | shasum -a 256 | awk '{print $1}')"
  [[ "$committed" == "$expected" ]] ||
    fail "COMMITTED_DIGEST_MISMATCH" "HEAD does not contain the approved document: $relative_path"
done < <(jq -r '.documents | to_entries[] | [.key, .value] | @tsv' "$RECEIPT")

jq -cn \
  --arg receipt "$RECEIPT_REL" \
  --arg base_commit "$base_commit" \
  --arg head "$(git -C "$ROOT" rev-parse HEAD)" \
  '{
    schema:"sonar.truth-promotion-verification.v1",
    status:"PASS",
    receipt:$receipt,
    base_commit:$base_commit,
    head:$head,
    implementation_authorized:true,
    production_authority:false
  }'
