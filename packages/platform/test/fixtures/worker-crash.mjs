// Worker protocol fixture: dies before reporting a result.
process.on("message", (message) => {
  if (message.type === "start") process.exit(3);
});
