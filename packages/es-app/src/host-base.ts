/* Where this page reads a Work host's Core and dashboard: its own host through `/oc` and `/es`, any
 * other Work host through the Local listener's read-only `/hosts/<id>/oc` and `/hosts/<id>/es`
 * routes. Cost and session reads share it, so every cross-host read goes through one place. Writes
 * never use another host's base: they happen on that host's own tab. */

const ID = /^[a-z][a-z0-9-]{0,31}$/

/** Path prefix for `host`'s Core; `self` is this page's own host id. Undefined for an invalid id. */
export const hostBase = (host: string | undefined, self: string | undefined) => {
  if (!host || host === self || host === "local") return "/oc"
  return ID.test(host) ? `/hosts/${host}/oc` : undefined
}

/** Path prefix for `host`'s dashboard, as `hostBase`. */
export const hostDashboard = (host: string | undefined, self: string | undefined) => {
  const base = hostBase(host, self)
  return base && `${base.slice(0, -3)}/es`
}
