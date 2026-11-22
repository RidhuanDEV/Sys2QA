/**
 * Launch options for the test browser: Playwright's own Chromium, or the one SYS2QA_BROWSER_EXECUTABLE names (for
 * machines whose preinstalled browser belongs to another Playwright version).
 */
export const browserOptions = () =>
  process.env.SYS2QA_BROWSER_EXECUTABLE ? { executablePath: process.env.SYS2QA_BROWSER_EXECUTABLE } : {};
