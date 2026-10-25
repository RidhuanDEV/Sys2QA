// Security fixture (ST-02): a test file is evidence of intent and must never be executed by analysis.
import { writeFileSync } from "node:fs";

writeFileSync(new URL("../SYS2QA_SENTINEL_testfile", import.meta.url), "executed");
