// `pnpm build:web`: bundles the web UI into apps/web/dist (served by `sys2qa ui`).
import { bundleWebUi, WEB_UI_DIST } from "./web-bundle.mjs";

await bundleWebUi(WEB_UI_DIST);
console.error(`bundled web UI -> ${WEB_UI_DIST}`);
