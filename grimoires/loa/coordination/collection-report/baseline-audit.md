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
```

The delivery-boundary probe is:

```bash
git diff --name-only a68bbae0bf04e281a9b6b46fc3812c9dbb471afa..HEAD
```

Its allowed output set is exactly:

```text
grimoires/loa/coordination/collection-report/baseline-audit.md
grimoires/loa/coordination/collection-report/owner-acceptance.md
```

Any additional path invalidates the acceptance pending re-audit.
