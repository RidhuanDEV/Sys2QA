# Web UI accessibility (IMP-211)

NFR-009 asks for keyboard-usable setup, review and manual execution, labeled controls, accessible status
announcements and no color-only status. Its acceptance is automated a11y checks plus a manual keyboard pass on the
core screens (Test Strategy §8). This record holds both.

## How the UI meets it

- Every control has a visible label (`<label for>`), every group a legend; hints are tied with `aria-describedby`.
- Each page moves focus to its `h1` when it opens; opening a scenario moves focus to its heading. A skip link leads to
  the main content. Focus is always visible (3 px outline).
- Results of actions (working, done, failed with the reason) are announced in a polite live region; errors are also
  shown in an `alert` with the code, the message and the next action (NFR-010).
- Every status is written out with a symbol; color only repeats it. Contrast meets WCAG AA in the light and dark
  color schemes.
- Tables have captions and header cells; the approval preview lists every selected version and the full binding
  before anything is approved.

## Automated checks (every push, `pnpm e2e`)

`tests/e2e/web-ui.e2e.test.ts` runs axe-core (rule tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`,
`best-practice`) inside the UI's own content security policy on every screen it visits: the start wizard (starting
point, inputs, authorization declaration), the package screen (evidence profile, readiness, system map and catalog),
the plan screen (coverage and review, scenario detail and decision, approval preview, and the same screen in the dark
color scheme), the project overview, the project list and the page without a session. Any violation fails the test;
the list of screens and findings is written to `reports/e2e/accessibility.json`.

## Keyboard-only pass

Automated in the same file (test "starts a project and approves a scenario with the keyboard alone"): using only Tab,
Shift+Tab, Enter, Space and typing, a person reaches the skip link and the main content, starts a Mode A project
(radio choice, fields, authorization checkbox, submit), lands on the package page with focus on its heading, opens a
scenario (focus moves to it), selects a scenario, fills the environment, previews the approval and approves it; the
approval is then active in the state database and announced.

| Date | Run | Result |
|---|---|---|
| 2026-11-14 | `pnpm e2e` on Linux, Chromium 141 | 7 tests passed; 11 screens checked, 0 axe violations; keyboard-only pass completed |

## Reviewer sign-off

The manual keyboard and readability-without-color review by a person (Test Strategy §8) is **pending**: it is a user
action, recorded here with the reviewer's name, date and notes when done.
