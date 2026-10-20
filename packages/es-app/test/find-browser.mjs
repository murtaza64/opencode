export const closeFindBrowser = async (server) => {
  const child = server.process()
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", resolve))
  const closed = server.kill()
  await exited
  // Chromium helpers can retain inherited pipes after the owned browser exits.
  // Close its parent-side pipes so Playwright can finish private-profile cleanup.
  child.stdio.forEach((stream) => stream?.destroy())
  await closed
}
