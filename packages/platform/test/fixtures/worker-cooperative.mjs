// Worker protocol fixture: runs until asked to cancel, then stops promptly.
process.on("message", (message) => {
  if (message.type === "start") process.send({ type: "progress", data: { started: true } });
  if (message.type === "cancel") process.exit(0);
});
setInterval(() => {}, 1000);
