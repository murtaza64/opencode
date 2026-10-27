/* Collapse bursts of change notifications into bounded snapshot refetches. */
/** Minimum spacing of event-driven snapshot refetches. */
export const EVENT_REFETCH_MS = 1000

/** Runs `run` at once, then at most once per `interval` while calls keep arriving (one trailing run). */
export const coalesced = (run: () => void, interval = EVENT_REFETCH_MS) => {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const fire = () => {
    timer = undefined
    last = Date.now()
    run()
  }
  const call = () => {
    if (timer) return
    const wait = last + interval - Date.now()
    if (wait <= 0) return fire()
    timer = setTimeout(fire, wait)
  }
  call.cancel = () => clearTimeout(timer)
  return call
}
