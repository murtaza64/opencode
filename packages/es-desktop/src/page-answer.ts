/* A page tab's main-frame navigation that never commits shows the failure page after `ms` instead of a blank view.
 * Every way a navigation ends clears it: a commit, a load failure, a provisional (pre-commit) failure, the view going
 * away, or `refused()`. Electron 42 emits no failure event for a navigation refused in will-navigate (only
 * did-start-navigation), so the guard that refuses one must call `refused()`; the page stays, it is not "no answer". */
// Structural on purpose (tests drive it with a plain EventEmitter): only `on` with these event names is used.
type Emitter = { on: (event: never, listener: never) => unknown; isDestroyed: () => boolean }

export const watchPageAnswer = (contents: Emitter, ms: number, onTimeout: () => void) => {
  let unanswered: ReturnType<typeof setTimeout> | undefined
  const clear = () => {
    clearTimeout(unanswered)
    unanswered = undefined
  }
  const on = contents.on.bind(contents) as (event: string, listener: (...args: never[]) => void) => unknown
  on("did-start-navigation", ((details: { isMainFrame: boolean; isSameDocument: boolean; url: string }) => {
    if (!details.isMainFrame || details.isSameDocument || details.url.startsWith("data:")) return
    clear()
    unanswered = setTimeout(() => {
      unanswered = undefined
      if (!contents.isDestroyed()) onTimeout()
    }, ms)
  }) as never)
  for (const event of ["did-navigate", "did-fail-load", "destroyed"]) on(event, clear as never)
  on("did-fail-provisional-load", ((_event: unknown, _code: number, _description: string, _url: string, mainFrame: boolean) => {
    if (mainFrame) clear()
  }) as never)
  return { refused: clear, pending: () => unanswered !== undefined }
}
