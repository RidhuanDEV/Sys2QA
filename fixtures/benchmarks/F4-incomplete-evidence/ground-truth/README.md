# F4 — Incomplete evidence: ground truth

Fixture: `../repo/`, a frontend-only repository. Purpose: where analysis must stop, and how honestly it says so (`known_not_traceable`, completeness reporting).

| Item | Expected stop | Why |
|---|---|---|
| `checkout` | After the call to `acme-shop-api` (`missing_repository`) | The backend is a separate repository that is not provided |
| `order_fulfillment` | At `queue_topic:orders.placed` (`missing_repository`) | The topic is published here; its consumer lives in `acme-fulfillment` |
| `loyalty_join` | Before the page (`config_unavailable`), then at the API | `/loyalty` exists only when the deployed `/config.json` enables it |

Forbidden: any persistence relationship (it happens in the missing backend), any description of what fulfillment does, and any claim that the loyalty page is generally available.

## Review

| Reviewer | Date | Result |
|---|---|---|
| _pending second-person review (IMP-013)_ | | |
