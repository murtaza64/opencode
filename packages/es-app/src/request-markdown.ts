/** An agent's request text as Markdown source in which any raw HTML stays literal text: `<` outside
 * code spans and fenced blocks is backslash-escaped, so only Markdown formatting renders (code keeps
 * its exact characters). The text is otherwise unchanged: nothing is added, fenced or rewritten. */
export const requestMarkdown = (text: string, routes?: { host?: string }) => {
  const plain = (part: string) => {
    const escaped = part.replace(/</g, "\\<")
    return routes ? linkSurfaceRoutes(escaped, routes.host) : escaped
  }
  let fence = ""
  return text.split("\n").map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = ""
      return line
    }
    if (marker) { fence = marker; return line }
    // Indented code (4+ spaces) renders verbatim already.
    if (/^( {4}|\t)/.test(line)) return line
    // Outside inline code spans (runs of backticks closed by the same run), escape `<`.
    return line.split(/(`+[^`]*?`+)/).map(part => /^(`+)[^`]*?\1$/.test(part) ? part : plain(part)).join("")
  }).join("\n")
}

const NAME = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?"
const ROUTE = `/\\?(?:surface=${NAME}|item=(?:${NAME}~)?surface(?::|%3A)${NAME})`
// A bare app-relative Surface route standing alone in prose: `/?surface=<id>` or `/?item=[<host>~]surface:<id>` (":" or
// "%3A"). Routes inside URLs, Markdown link targets or longer queries do not match.
const SURFACE_ROUTE = new RegExp(`(^|[\\s(\\[])(${ROUTE})(?=$|[\\s).,;:!?\\]])`, "g")
const ROUTE_PARTS = new RegExp(`^/\\?(?:surface=(${NAME})|item=(?:(${NAME})~)?surface(?::|%3A)(${NAME}))$`)

/** The in-app Surface reader href for one Surface route, or undefined for anything else. On another host's card
 * (`host`) a route without a host opens that host's Surface; a route naming a host keeps it. */
export const surfaceRouteHref = (route: string, host?: string) => {
  const parts = ROUTE_PARTS.exec(route)
  if (!parts) return
  const id = parts[1] ?? parts[3]
  const owner = parts[2] ?? host
  if (owner) return `/?item=${encodeURIComponent(`${owner}~surface:${id}`)}`
  return parts[1] ? `/?surface=${id}` : `/?item=${encodeURIComponent(`surface:${id}`)}`
}

/** Turns bare Surface routes into Markdown links to the in-app Surface reader, keeping the shown text. */
export const linkSurfaceRoutes = (markdown: string, host?: string) =>
  markdown.replace(SURFACE_ROUTE, (match, before: string, route: string, offset: number) =>
    // `](/?surface=x)` is already a Markdown link target.
    before === "(" && markdown[offset - 1] === "]" ? match : `${before}[${route}](${surfaceRouteHref(route, host)})`)

/** A request the human must carry out by hand: a blocker, or text with at least two numbered steps
 * ("1." or "1)" at a line start). Such a request stays readable in full beside any brief, because a
 * summary can drop the exact values (limits, operators, URLs) the human has to type. */
export const requestHasSteps = (record: { kind: string; context: string }) =>
  record.kind === "blocker" || (record.context.match(/^\s{0,3}\d{1,2}[.)]\s+\S/gm)?.length ?? 0) >= 2
