// Worker protocol fixture: ignores cancel requests and never finishes, so only a kill stops it.
process.on("message", (message) => {
  if (message.type === "start") process.send({ type: "progress", data: { pid: process.pid } });
});
setInterval(() => {}, 1000);
