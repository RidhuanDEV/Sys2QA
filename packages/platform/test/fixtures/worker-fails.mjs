// Worker protocol fixture: reports a non-transient failure.
process.on("message", (message) => {
  if (message.type === "start") process.send({ type: "error", message: "selector not found" }, () => process.exit(1));
});
