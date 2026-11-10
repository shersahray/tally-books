# Audit AI staging acceptance / deployment gates

This is **draft-only**. Do not merge, deploy, or enable for paying customers before a security review and signed-off staging exercise. Use synthetic documents only.

## Sandbox worker

Build from the repository root:
```sh
docker build -f ops/audit-worker/Dockerfile -t sumlora/audit-ocr:staging .
```

Configure the Sumlora **application host** to call the Docker CLI (which must be separately provisioned and access-controlled). These are JSON array arguments, not shell text:

```
AUDIT_AI_WORKER_BIN=docker
AUDIT_AI_WORKER_ARGS='["run","--rm","-i","--network","none","--read-only","--cap-drop","ALL","--security-opt","no-new-privileges","--pids-limit","64","--memory","256m","--cpus","1","--tmpfs","/tmp:rw,noexec,nosuid,size=48m","sumlora/audit-ocr:staging"]'
```

The application rejects PDF uploads when the worker is not configured or cannot start. **Security note:** Access to the Docker daemon is privileged. Restrict the Docker invocation and images at host level, pin a scanned image digest, use a dedicated account, and consider an isolated service behind an authenticated API instead of exposing the Docker socket to the app. The design is not independently penetration tested. The worker image must be built and run in staging; container limits above have not been verified here. Install and update `clamscan` and its signature database on the main app host (scan must complete before worker invocation).

## Encryption key recovery

Generate a random 32-byte key into a managed secret store; expose only as `AUDIT_AI_STORAGE_KEY` (64 hex characters). Never commit or log it. Back up separately under restricted access. To validate recovery in staging, upload one **synthetic** PDF to a disposable company, restore the encrypted SQLite backup and secret in an isolated disposable instance, then ensure download/decryption succeeds; confirm a wrong key fails. This feature **does not implement key rotation**.

## Two-firm acceptance test

1. Create synthetic firm A and firm B, each with staff and one company; leave both entitlements disabled.
2. Attempt each evidence route while disabled: expect denial.
3. Enable **only** firm A company using a platform administrator; test A staff upload, OCR, download, GL suggestions, evidence review and pair review. Verify the general ledger remains unchanged.
4. Sign in as B staff and attempt to access A's company and document IDs: expect denial for listing, download, matching, reviewing and deletion.
5. Revoke A premium entitlement while a synthetic upload is in progress; ensure no subsequent upload persists.
6. Enable B company and demonstrate evidence cannot be viewed/decrypted across company IDs; test read-only accounts and client portal denials.
7. Apply legal hold to synthetic A evidence and ensure owner deletion fails until explicit release; verify audit trail, associated pair review cleanup, and backups.
8. Test small scanned and text PDFs, corrupt file, 10 MiB boundary, 25-page boundary, malware-scanner unavailable, and duplicate content.

Keep records of test execution, representative PDFs, accountable reviewer and approval. All current automated tests are **unit tests**, not substitutes for live HTTP or Azure validation.

## Retention

The firm owner can set/release a document legal hold and delete evidence with a reason; deletion removes the active database blob and associated pair reviews. Automatic retention expiry, backups and immutable legal holds are **not** provided. Define a legally approved retention schedule before implementing automatic deletion. SQLite/WAL, offsite backups and storage snapshots may retain deleted data. Do not represent manual deletion as permanent erasure.

## Release signoff

Require green Audit AI CI and application CI on the final commit, staging sandbox/container validation, restore drill, multi-firm test signoff, PDF scanner deployment, and accounting staff acceptance. Only then request explicit approval to merge/deploy. The premium flag remains OFF by default.
