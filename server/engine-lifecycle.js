export function createEngineLifecycle({ acquire, listen, recover, start, stop, close, release }) {
  let phase = "stopped";
  let ownsLock = false;
  let startPromise = null;
  let stopPromise = null;
  let cleanupPromise = null;
  let stopRequested = false;
  const startup = new AbortController();

  function cleanUp() {
    if (cleanupPromise) return cleanupPromise;
    if (!ownsLock) return Promise.resolve();
    cleanupPromise = Promise.resolve().then(async () => {
      await stop();
      await close();
      if (await release() !== true) throw new Error("Engine ownership could not be released; inspection required.");
      ownsLock = false;
    });
    return cleanupPromise;
  }

  return {
    get phase() { return phase; },
    start() {
      if (startPromise) return startPromise;
      if (stopRequested) return Promise.reject(new Error("Stopped engine cannot start again in this process."));
      phase = "starting";
      startPromise = (async () => {
        let result;
        try { result = await acquire(startup.signal); }
        catch (error) {
          if (startup.signal.aborted && error.name === "AbortError") return;
          phase = "failed";
          throw error;
        }
        if (!result.ok) { phase = "failed"; throw new Error(result.message); }
        ownsLock = true;
        try {
          if (stopRequested) return;
          await listen(startup.signal);
          if (stopRequested) return;
          await recover();
          if (stopRequested) return;
          await start();
          if (!stopRequested) phase = "ready";
        } catch (error) {
          if (startup.signal.aborted && error.name === "AbortError") return;
          phase = "failed";
          try { await cleanUp(); } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Engine startup and cleanup failed; ownership remains uncertain.");
          }
          throw error;
        }
      })();
      return startPromise;
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopRequested = true;
      startup.abort();
      phase = "stopping";
      stopPromise = (async () => {
        await startPromise?.catch(() => {});
        await cleanUp();
        phase = "stopped";
      })();
      return stopPromise;
    }
  };
}
