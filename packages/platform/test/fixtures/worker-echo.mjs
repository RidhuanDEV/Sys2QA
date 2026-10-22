// Worker protocol fixture: reports progress, then returns its payload, process.execArgv and environment keys.
process.on("message", (message) => {
  if (message.type !== "start") return;
  process.send({ type: "progress", data: { step: 1 } });
  process.send(
    {
      type: "result",
      result: { echo: message.job.payload, execArgv: process.execArgv, envKeys: Object.keys(process.env) },
    },
    () => process.exit(0),
  );
});
