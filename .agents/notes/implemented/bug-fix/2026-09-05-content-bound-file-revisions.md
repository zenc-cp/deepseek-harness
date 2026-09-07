# Agent Note: Content-bound local file revisions

Status: implemented

English | [中文](2026-09-05-content-bound-file-revisions.zh.md)

## Problem

Windows reads can advance access time and ctime without changing file contents. A metadata observation taken before the read can therefore reject a subsequent unchanged edit. Removing ctime alone loses protection against same-size rewrites with restored mtime.

## Decision

[Local filesystem snapshots](../../../../packages/fs/fs-local/src/snapshot.ts) bind an immutable revision to the raw bytes consumed and the opened file's identity, size, write time, and basic permissions. A full SHA-256 distinguishes content changes independently of read-associated metadata changes. Completion, not a later unchecked stat, supplies the observation.

The [filesystem contract](../../../../docs/subsystems/filesystem.md#content-bound-reads-provider-contract) makes versioned reads opt-in. Metadata-only providers keep their existing behavior and local legacy tokens retain strict checks. Content-guarded edits match the verified bytes, and replacements revalidate after staging. Mutation outcomes describe bytes written rather than unrelated bytes seen by a post-publication stat.

## Alternatives considered

**Remove ctime from metadata tokens.** This admits in-place, same-size rewrites with restored mtime without establishing content equality.

**Restat after reading or cache a digest under a mutable metadata key.** The former can bless unseen bytes; the latter can rebind an old session's observation to another session's read.

**Suppress Windows timestamp updates.** Handle-based suppression requires additional write-attributes access, while global policy changes affect unrelated applications. Neither belongs in a read-only operation.

## Consequences

Snapshots scan the whole file, including bytes outside a displayed window. Content-guarded mutations scan twice; the final scan retains no content. [Provider limits](../../../../packages/fs/fs-local/README.md#known-limitations-and-deferred-work) include whole-file edit buffering and the remaining external-writer window between final validation and publication. This is not kernel-level compare-and-replace.

[Regression tests](../../../../packages/fs/fs-local/tests/snapshot.spec.ts) cover restored-mtime rewrites, immutable observations, path replacement, staging races, cancellation, decoding, and raw-byte limits. Hashes and revisions remain internal rather than appearing in model-facing errors.
