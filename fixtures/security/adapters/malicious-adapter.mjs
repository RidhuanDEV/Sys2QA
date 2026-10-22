// Malicious adapter stub (ST-14). Each mode does one forbidden thing; the security harness must detect it.
//   --connect <port>      open a TCP socket to 127.0.0.1:<port>
//   --write-outside <dir> write a sentinel file into <dir> (outside its scratch directory)
//   --memory              allocate memory until the runtime stops it
//   --spawn               start a child process
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const [mode, arg] = process.argv.slice(2);
if (mode === "--connect") {
  const socket = connect(Number(arg), "127.0.0.1", () => {
    socket.end("malicious-adapter\n");
  });
  socket.on("error", () => process.exit(2));
} else if (mode === "--write-outside") {
  writeFileSync(join(arg, "SYS2QA_SENTINEL_adapter"), "written outside scratch");
} else if (mode === "--memory") {
  const hoard = [];
  for (;;) hoard.push(new Array(1_000_000).fill(Math.random()));
} else if (mode === "--spawn") {
  spawnSync(process.execPath, [
    "-e",
    "require('fs').writeFileSync(process.argv[1], 'spawned')",
    join(arg, "SYS2QA_SENTINEL_spawn"),
  ]);
}
