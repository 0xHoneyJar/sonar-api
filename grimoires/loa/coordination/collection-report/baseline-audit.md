# ACCEPT-SONAR baseline audit transcript

Author-recorded advisory evidence captured for `ACCEPT-SONAR`. This transcript
does not replace an independent CI attestation; every command is intentionally
rerunnable from the pull-request checkout.

```text
$ git remote get-url origin
https://github.com/0xHoneyJar/sonar-api.git

$ git cat-file -t a68bbae0bf04e281a9b6b46fc3812c9dbb471afa
commit

$ git show -s --format='%H %cI %s' a68bbae0bf04e281a9b6b46fc3812c9dbb471afa
a68bbae0bf04e281a9b6b46fc3812c9dbb471afa 2026-07-14T00:17:27-07:00 feat(svm): publish Pythenians NFT image + uri on svm_collection_nft (PYTH-1) (#160)

$ git diff --name-only a68bbae0bf04e281a9b6b46fc3812c9dbb471afa..HEAD
grimoires/loa/coordination/collection-report/baseline-audit.md
grimoires/loa/coordination/collection-report/owner-acceptance.md
grimoires/loa/coordination/collection-report/robinhood-chain-evidence.json
```

The recorded delivery-boundary probe is content-scoped rather than
self-referential: a commit cannot contain its own final hash. The exact head is
bound by the external Bridgebuilder review marker; this transcript constrains
what that reviewed head may change.

The rerunnable probe for a checked-out candidate head is:

```bash
git diff --name-only a68bbae0bf04e281a9b6b46fc3812c9dbb471afa..HEAD
```

Its allowed output set is exactly:

```text
grimoires/loa/coordination/collection-report/baseline-audit.md
grimoires/loa/coordination/collection-report/owner-acceptance.md
grimoires/loa/coordination/collection-report/robinhood-chain-evidence.json
```

Any additional path invalidates the acceptance pending re-audit.
