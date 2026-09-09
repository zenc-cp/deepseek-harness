# Windows filesystem freshness fix plan

English | [中文](windows-freshness-fix-plan.zh.md)

Status: approved by the user through the local-fix approval question. This plan changes only the isolated `turn-step-state` worktree. It does not authorize a commit, push, installation, running-harness rebuild/restart, Windows policy change, or deployment.

## Problem and evidence

The current `FileSystem.stat()` returns a metadata version. `readText()` and `streamText()` return content without a revision tied to those bytes. The text read tool, image read tool, and string-replace editor view record the pre-read metadata version. On the tested Windows filesystem, a plain read can update access time and ctime, immediately making that observation stale.

Relevant contracts:

- `packages/fs/fs/src/index.ts`: stat/lstat return metadata only; directory listings explicitly never read file contents. Text decoding belongs to the backend.
- `packages/fs/fs-local/src/index.ts`: mutation guards run under the per-target lock before matching; they currently compare metadata strings.
- `packages/fs/tool-fs/src/read.ts`, `read-image.ts`, and `packages/fs/tool-str-replace-editor/src/index.ts`: successful reads record the pre-read version.
- `packages/fs/fs-local/tests/filesystem.spec.ts`: the existing same-size/restored-mtime test uses `fs.writeText`, which atomically replaces the file. It does not isolate an in-place overwrite preserving file identity.

The previous investigation has reproducible failures. No new implementation or test code has been changed for this plan.

## Proposed smallest complete change

Add an optional backend versioned-read capability, leaving existing metadata APIs and ordinary non-observing reads compatible:

1. A versioned text stream whose final completion value supplies the opaque `FsVersion`, after all raw bytes have been hashed and text validation succeeds. The consumer captures that completion value while the existing window builder consumes the whole stream. Never expose a final token for an incomplete or cancelled stream.
2. A bounded raw-byte read variant returning bytes and their opaque version together, for the image reader.
3. The local backend implements these operations using a single opened file handle per read, incremental full SHA-256 over raw bytes before decoding, and file-identity checks. Handle/path replacement or detectable read instability fails closed. Tokens bind to the bytes delivered, not an unchecked post-read metadata value.
4. Read tools use the new capability where available and emit observations only after successful completion. Backends without the capability keep their existing metadata-token behavior, with no new claim of content-version guarantees.
5. Local guarded mutations recognize a versioned content token and verify current identity/content under the existing lock before literal matching or replacement. Reuse bytes already needed for an edit where possible; otherwise hash incrementally. Legacy stat-derived tokens retain their existing strict metadata comparison. Invalid tokens fail closed.
6. Local write/edit outcomes return a content-bound token for the bytes written, so write-to-edit flows do not revert to a fragile metadata observation. Post-publication uncertainty must not create a token that authorizes unseen different bytes.

The token format remains opaque outside the local backend. Use full SHA-256, not truncated or non-cryptographic hashes. Do not log content digests or include them in model-facing errors. No cache may rebind an old metadata token to newly read bytes.

This deliberately separates content freshness from access-time bookkeeping. It is not an all-metadata audit trail. Existing permission enforcement, sandbox fences, DACL preservation, and atomic publication mechanics stay intact.

## Phases and dependencies

### 1. Contract and deterministic red tests

Define the capability and token rules first. Add tests through the existing Vitest runner before implementing the fix. Use fixture-only race hooks, not sleeps or machine-wide timestamp changes.

Required tests:

- Simulated access/ctime-only drift after a successful read permits a guarded edit of unchanged bytes.
- A true in-place rewrite with different same-length bytes, the same identity, and restored mtime is rejected.
- A writer changing data after the bytes were read but before read completion cannot obtain authorization through a post-read timestamp.
- Replacing the path while its old handle is open is rejected.
- Two independent observations cannot rebind one another's tokens; stale session A remains stale after session B reads newer bytes.
- Two same-session concurrent guarded mutations have one winner.
- An edit miss or ambiguous match does not invalidate a content-bound observation solely because reading updated timestamps.
- Legacy metadata guards still fail closed.

### 2. Local implementation and consumer integration

After observing the intended red failures, implement the capability and update all three observing read surfaces. Keep the existing observation-policy vocabulary and actor/session isolation. Sandbox mutation checks run before any guarded mutation I/O as they do today.

Extend coverage for raw-byte fidelity (BOM and CRLF), whole-file guards after windowed reads, binary/image reads, invalid UTF-8, empty files, missing/recreated files, cancellation, partial consumption, file growth, and write-to-edit cycles. Adapt the diagnostic assertions to content-revision stability; do not assert that Windows metadata itself cannot change after a read.

### 3. Verification

Run the existing repository commands with complete summaries and preserved exit codes:

- `vitest.CMD run packages/fs --maxWorkers=1 --reporter=default`
- Mocked E2B filesystem tests, confirming unchanged fallback behavior without contacting a cloud sandbox.
- The previously green core agent/session, subprocess, and PowerShell-tool selection (previous baseline: 42 files, 819 tests).
- Affected TypeScript project builds using the repository's installed TypeScript.
- Bounded Windows integration repetitions, reported as supplementary evidence, not a substitute for deterministic race tests.

No full-monorepo pass claim until a separate complete run finishes. No Linux pass claim unless actually run on Linux.

## Acceptance criteria

- Deterministic tests demonstrate red before implementation and green afterward.
- Unchanged read-to-write/edit flows succeed despite access/ctime changes.
- Same-size/restored-mtime in-place changes, identity replacement, stale observations, and the deterministic concurrent-writer cases are rejected before matching/publication.
- No new full-file content I/O is hidden inside stat, lstat, or directory listing.
- Streaming memory remains bounded; cancellation and growth bounds prevent an unbounded guard scan.
- No partial read grants a full-file observation.
- Existing sandbox/permission behavior, secret filtering, and remote-backend behavior do not regress.
- All observing read surfaces and mutation outcomes use the appropriate revision contract.

## Risks and explicit limits

Content-aware guarded replacement costs an O(file size) scan unless the bytes are already required for an edit. Measure and document that cost; do not remove the scan via a metadata-only shortcut.

The existing per-target lock serializes only DSH's own mutations. Digest checks and identity checks do not create a kernel-level atomic compare-and-replace against arbitrary external writers. A writer racing after the final validation can still fall into a publication gap. Narrow that gap and test chosen interleavings, but do not promise a filesystem transaction or eliminate it by adding a generic retry engine.

Do not remove ctime from legacy tokens, bless an unchecked post-read version, or disable Windows access-time updates. Native `SetFileTime` suppression is not the default: Microsoft documents that it requires `FILE_WRITE_ATTRIBUTES`, which would expand the permissions required to read a file. Source: https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-setfiletime

The independent design review was advisory. Its suggestions to truncate/use non-cryptographic hashes, return unfinished stream revisions, or suppress native timestamps are not adopted.
