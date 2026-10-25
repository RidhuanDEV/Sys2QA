# ADR-011: OS credential store through @napi-rs/keyring, with a passphrase-encrypted file fallback

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-22 |
| Decided by | Maintainer delegation (implementation choice); spike SP-2 |
| PRD links | SEC-011, SEC-004, QAA-FR-005, NFR-008 |

## Context
Credential values (environment logins, model API keys) must never be stored in `state.db`, configuration, logs or packages. The PRD and Data Model require references (`secretref:`) with values in the OS credential store, plus an encrypted-file fallback (Data Model §1 class F). Sys2QA runs on Linux, macOS and Windows, including headless Linux and CI containers that have no Secret Service.

## Evidence (SP-2, 2026-10-22)
| Candidate | Finding |
|---|---|
| `keytar` 7.9.0 | Atom organization repository is archived; native addon built through prebuild/node-gyp. Not chosen |
| `@napi-rs/keyring` 2.1.2 | MIT; Rust `keyring` crate through N-API; prebuilt optional packages for darwin x64/arm64, linux x64/arm64 (glibc and musl), win32 x64/arm64; async API (`AsyncEntry.setPassword/getPassword/deleteCredential`) with `AbortSignal`; releases 1.2.0 (2025-09) → 2.1.2 (2026-10) |
| Probe in a headless Linux container | `setPassword` rejected in 4 ms with `Couldn't access platform storage: AccessDenied`, so there was no hang and the failure is detectable |
| Linux store selection | Default is Secret Service, falling back to the kernel keyring (`keyutils`). The kernel keyring does not survive a reboot, so credentials could silently disappear |

## Decision
- **Primary backend:** `@napi-rs/keyring`, service name `sys2qa`, one entry per secret reference. On Linux the store is pinned to `secret-service`, so the volatile kernel keyring is never used.
- **Fallback:** `<sys2qa-home>/secrets.enc`, a JSON file holding one AES-256-GCM entry per reference (random 96-bit IV, authenticated with the reference as AAD). The key is derived with scrypt (N = 2^15, r = 8, p = 1, 16-byte salt) from a passphrase in `SYS2QA_SECRETS_PASSPHRASE`. The passphrase is never stored. Without a usable OS store and without a passphrase, secret operations fail with `SECRET_STORE_UNAVAILABLE` and a remediation; there is no unencrypted or key-next-to-file mode.
- **Selection:** configuration `secrets.backend` = `auto` (default: OS store if a probe write/read/delete succeeds, else the encrypted file if a passphrase is set), `os` or `file`.
- **References** are `secretref:<project-ulid>.<name>`. The table `secret_refs` (no values) records which project owns each reference, so values can be deleted with the project (SEC-015). A job can resolve only references of its own project (SEC-011).
- **Use:** values are resolved only for a job (`injectForJob`), registered with the redactor for exact-match redaction, and audited as `credential.used`. They are never written to `state.db`, logs or job payloads. Worker processes receive them only through the job's injection, never through the environment.
- Values are never accepted through MCP (they would pass through a model's context); the CLI reads them from stdin, not from arguments.

## Alternatives considered
| Alternative | Why not chosen |
|---|---|
| `keytar` | Archived upstream |
| Encrypted file only | Weaker than the OS store on desktops; the PRD prefers the OS store |
| Fallback key stored next to the file | Only obfuscation; gives a false sense of protection |
| Kernel keyring on Linux | Not persistent across reboots |

## Consequences
- Positive: no compiler needed; desktops use the platform's protected store; headless servers have an explicit, encrypted option.
- Negative: headless users must manage a passphrase; a lost passphrase means re-entering credentials.
- Follow-up: IMP-010 (implementation), IMP-019 (deletion with the project).

## Verification
Store tests: OS backend contract against an in-memory double; encrypted-file round trip, wrong passphrase, tampered entry and wrong-reference AAD. Leak tests: after storing and using planted secrets, `state.db`, logs and audit exports contain none of them (ST-04). Cross-project resolution is refused (ST-11 part).
