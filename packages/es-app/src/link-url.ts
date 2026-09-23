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
