# ADR-012: Read Git metadata in-process with isomorphic-git, never through the `git` binary

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-25 |
| Decided by | Maintainer delegation (implementation choice); IMP-102 |
| PRD links | QAA-FR-004, CON-006, OD-04, SEC-001, SEC-002, SEC-017 |

## Context
SAA must record the exact revision it analyzed: the HEAD commit, whether the working tree differs from it, and a fingerprint of the difference (CON-006, OD-04). Reading HEAD alone is easy, but deciding whether the tree is dirty needs the index and the HEAD tree, which means reading Git's object database (loose objects, pack files, deltas). The repository is untrusted input, and so is its `.git` directory when the user received the directory from someone else.

## Evidence (2026-10-25)
| Finding | Detail |
|---|---|
| `git status` runs repository-configured commands | In a scratch repository with `core.fsmonitor` and a `filter.<name>.clean` driver set to commands that write sentinel files, plain `git status --short` after an edit created both sentinels. Hooks, `diff.<name>.textconv` and filter `process` drivers are further entry points. Overriding them one by one with `-c` is a deny-list that a new Git version can outgrow |
| The `git` binary would also break the module rule | `saa-core` may not start processes (`no-process-spawn-in-analysis`, SEC-002) |
| isomorphic-git 1.43.3 | MIT, pure JavaScript, takes a caller-supplied `fs` object, has no network code in its main entry (transports are separate opt-in modules), and offers `statusMatrix({ refresh: false })`, which never writes the index |
| isomorphic-git's stat check | Compares stat data at one-second resolution without Git's racy-entry rule, so a same-size edit in the second the index was written reads as unmodified (reproduced by a test before the fix) |

## Decision
- Git metadata is read in-process with **isomorphic-git**, pinned to a release at least two weeks old (`~1.43.3`).
- isomorphic-git gets a **sandboxed, read-only filesystem**: absolute paths are mapped back to root-relative paths and resolved through `RootSandbox`; `lstat` and `readlink` do not follow the final link; every write fails with `EROFS`. A refused path (for example a `.git` file pointing outside the root) is reported to the library as missing, and the result is discarded and labeled `git_metadata_outside_root`.
- **Racy entries** are re-checked as Git does: a file reported unmodified whose modification time is not older than the index is hashed as a blob and compared with HEAD; a difference that disappears when CRLF is normalized to LF is not a change.
- No transport is ever passed to isomorphic-git, so it cannot fetch (SEC-017).
- Outcomes: a clean checkout gives `git_commit` with `worktree_dirty: false`; a dirty one gives the base commit, `worktree_dirty: true` and a SHA-256 `dirty_fingerprint` over the changed paths, their status and their content; no Git, no commits, metadata outside the root, unreadable metadata or a non-SHA-1 object format give a `content_fingerprint` over the included files with a label. The remote URL is kept only without credentials, query or fragment, and dropped if it still looks secret.

## Alternatives considered
| Alternative | Why not chosen |
|---|---|
| Spawn `git` with hardening flags (`-c core.fsmonitor=false`, `core.hooksPath`, no filters) | Deny-list of execution points; still a process start from analysis code; depends on the user's Git version and system configuration |
| Hand-written reader for refs, index and pack files | Several hundred lines of delta and index-format code that a maintained library already provides |
| HEAD only, no dirty detection | Would present a modified tree as a clean commit, which CON-006 forbids |

## Consequences
- Positive: no repository-controlled command can run while the revision is identified; reads stay inside the root; nothing is written or fetched.
- Negative: isomorphic-git reads pack files whole, so a pack larger than 512 MiB makes the metadata unreadable and the revision falls back to a labeled content fingerprint; SHA-256 repositories also fall back. Git's `core.autocrlf` from user or system configuration is not read, which the CRLF rule above compensates for. An edit that keeps both size and modification time older than the index is not detected (Git has the same limit).
- Follow-up: the fingerprint cache (IMP-115) can reuse the per-file hashes.

## Verification
`packages/saa-core/test/revision.test.ts` (clean, dirty, staged-only, racy edit, deleted and untracked files, ignored files, no Git, no commits, `.git` file outside the root, SHA-256 object format, remote sanitizing, no file written even after stat drift); `tests/security/st-02-no-execution.test.ts` (fsmonitor, filter drivers, textconv and hooks configured; no process started, no sentinel, no file changed); `tests/security/sec-017-no-acquisition.test.ts` (remotes pointing at a listening trap; no socket, fetch or DNS call).
