# ACCEPT-SONAR baseline audit transcript

Author-recorded advisory evidence captured for `ACCEPT-SONAR`. This transcript
does not replace an independent CI attestation; every command is intentionally
rerunnable from the pull-request checkout.

```text
$ git remote get-url origin
https://github.com/0xHoneyJar/sonar-api.git

$ git rev-parse HEAD
980804706920005ad5c1e74e19c4636c427b9836

$ git cat-file -t a68bbae0bf04e281a9b6b46fc3812c9dbb471afa
commit

$ git show -s --format='%H %cI %s' a68bbae0bf04e281a9b6b46fc3812c9dbb471afa
a68bbae0bf04e281a9b6b46fc3812c9dbb471afa 2026-07-14T00:17:27-07:00 feat(svm): publish Pythenians NFT image + uri on svm_collection_nft (PYTH-1) (#160)

$ git diff --name-only a68bbae0bf04e281a9b6b46fc3812c9dbb471afa..980804706920005ad5c1e74e19c4636c427b9836
grimoires/loa/coordination/collection-report/baseline-audit.md
grimoires/loa/coordination/collection-report/owner-acceptance.md
```

The recorded delivery-boundary probe above is pinned to the exact PR head that
was reviewed. To re-audit a later head, replace the terminal revision with that
exact commit and compare the observed output to the allowed set below; do not
inherit this transcript as evidence for a different revision.

The rerunnable probe for a checked-out candidate head is:

```bash
git diff --name-only a68bbae0bf04e281a9b6b46fc3812c9dbb471afa..HEAD
```

Its allowed output set is exactly:

```text
grimoires/loa/coordination/collection-report/baseline-audit.md
grimoires/loa/coordination/collection-report/owner-acceptance.md
```

Any additional path invalidates the acceptance pending re-audit.
