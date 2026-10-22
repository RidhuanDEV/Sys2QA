# ADR-007: Egress enforcement through a local scope-enforcing proxy

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-22 |
| Decided by | Claude under maintainer delegation |
| PRD links | SEC-007, SEC-008, SEC-020, SEC-025, SEC-003 |

## Context
SEC-007 requires egress enforcement outside the application logic, revalidation of redirects, and DNS-rebinding protection. URL parsing in application code is insufficient, and the model must never decide scope. In T1 there is no network infrastructure to rely on.

## Decision
The runtime observation service runs a **local forward proxy** (HTTP and HTTPS `CONNECT`) on loopback, with a per-job credential. **Every browser worker is configured to use it**; L3 containers can reach nothing else. For each connection the proxy:
1. resolves the destination and checks the **resolved IP** against the job's scope policy at connection time: blocking loopback, private, link-local and metadata ranges unless local owner mode allows a named target (SEC-008); connections are pinned to the checked IP;
2. checks scheme, host and port against the allowlist; path prefixes are checked by the observation service at navigation level;
3. applies per-environment rate limits (SEC-020);
4. logs every allow or deny decision to audit, with query strings redacted.

Redirects are new connections and therefore re-checked. TLS is **not** intercepted; HTTPS path-level checks happen in the browser-control layer (navigation and request interception) and are defense-in-depth on top of host-level proxy enforcement.

## Alternatives considered
| Alternative | Why not chosen |
|---|---|
| Playwright request interception only | Runs inside the controlled process; can miss requests (service workers, WebSockets) and offers no IP-level check |
| OS firewall rules | Platform-specific, needs admin rights (contradicts MD-6) |
| TLS-intercepting proxy | Needs certificate installation; increases risk |

## Consequences
- Positive: one enforcement point (SEC-025); scope decisions are code, not prompts.
- Negative: proxy correctness is security-critical and needs a dedicated test suite; WebSocket and HTTP/2 handling must be covered.
- Follow-up: IMP-401, IMP-015.

## Verification
SSRF fixture server: redirects to private IPs, DNS-rebinding hostnames, metadata IPs, off-scope hosts and WebSocket upgrades are all denied and audited.
