import { acquireSingleInstanceLock, releaseSingleInstanceLock } from "../../server/lock.js";

const file = process.argv[2];
process.on("message", async (message) => {
  if (message === "acquire") process.send(await acquireSingleInstanceLock({ file }));
  if (message === "release") {
    await releaseSingleInstanceLock({ file });
    process.disconnect();
  }
});
process.send("ready");
