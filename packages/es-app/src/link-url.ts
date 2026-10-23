const githubLink = (value: string) => {
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return
  const outer = URL.parse(value)
  const wrapped = outer?.origin === "https://duo.fyi" && !outer.username && !outer.password &&
    outer.pathname.startsWith("/ink/") && value.includes("/ink/")
  const target = wrapped ? value.slice(value.indexOf("/ink/") + 5) : value
  const url = URL.parse(target)
  if (!url || !["https:", "http:"].includes(url.protocol) || url.hostname !== "github.com") return
  return {
    target,
    pr: !url.username && !url.password && !url.port &&
      /^\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*(?:\/.*)?$/.test(url.pathname),
  }
}

/** Keep the destination verbatim, including its query and fragment, when adding/removing the Ink prefix. */
export const linkUrl = (value: string) => {
  const link = githubLink(value)
  if (!link) return value
  return link.pr ? `https://duo.fyi/ink/${link.target}` : link.target
}

// Published web (3181), dev (3100) and the desktop app (60302) serve the same es-app against the same
// services, so agent-shared links to any of them open the route in whichever client was clicked.
const APP_PORTS = ["3181", "3100", "60302"]
const APP_ROUTE = /^\/(?:|cloud|map|new|desk|issue|doc|session\/[\w-]+)$/

/** In-app path for a link to an es-app route on this origin or a known loopback es-app origin. */
export const appPath = (value: string, origin: string) => {
  const url = URL.parse(value, origin)
  if (!url || url.username || url.password || !APP_ROUTE.test(url.pathname)) return
  const known = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && APP_PORTS.includes(url.port)
  if (url.origin !== origin && !known) return
  return url.pathname + url.search + url.hash
}

/** Plain clicks on app links, including target=_blank and other es-app ports, navigate in place. */
export const installAppLinks = (navigate: (path: string) => void) => {
  const click = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = (event.target as Element | null)?.closest?.("a[href]")
    if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download") || anchor.getAttribute("href")?.startsWith("#")) return
    const path = appPath(anchor.href, location.origin)
    if (!path) return
    event.preventDefault()
    navigate(path)
  }
  // Bubble phase: the router and session-ref handlers run first and mark the event handled.
  document.addEventListener("click", click)
  return () => document.removeEventListener("click", click)
}

export const installInkLinks = () => {
  const rewrite = (event: Event) => {
    const anchor = (event.target as Element | null)?.closest?.("a[href]")
    if (!(anchor instanceof HTMLAnchorElement) || !githubLink(anchor.href)) return
    anchor.href = linkUrl(anchor.href)
    if (!anchor.target) anchor.target = "_blank"
  }
  // mousedown precedes middle/modified-click navigation; click also covers keyboard activation.
  document.addEventListener("mousedown", rewrite, true)
  document.addEventListener("click", rewrite, true)
  return () => {
    document.removeEventListener("mousedown", rewrite, true)
    document.removeEventListener("click", rewrite, true)
  }
}

/** Split plain text into prose and its http(s) URLs, each URL with the href the app opens. */
const URL_RE = /https?:\/\/[^\s<>"'`]+/g
// Sentence punctuation and unmatched closing brackets after a URL belong to the prose.
const TRAILING = /[.,;:!?'")\]}>]+$/

export const linkSegments = (text: string) => {
  const segments: ({ text: string } | { text: string; href: string })[] = []
  let last = 0
  for (const match of text.matchAll(URL_RE)) {
    const trailing = TRAILING.exec(match[0])?.[0] ?? ""
    // Keep a closing parenthesis that balances one inside the URL, e.g. wiki links.
    const kept = trailing.startsWith(")") && match[0].slice(0, -trailing.length).includes("(") ? trailing.slice(1) : trailing
    const url = kept ? match[0].slice(0, -kept.length) : match[0]
    if (!URL.canParse(url)) continue
    if (match.index > last) segments.push({ text: text.slice(last, match.index) })
    segments.push({ text: url, href: linkUrl(url) })
    last = match.index + url.length
  }
  if (last < text.length) segments.push({ text: text.slice(last) })
  return segments
}
