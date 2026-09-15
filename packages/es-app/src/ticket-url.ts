export const ticketUrl = (key: string, url?: string | null): string => {
  if (url) return url
  const github = key.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/)
  if (github) return `https://github.com/${github[1]}/issues/${github[2]}`
  if (/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(key)) return `https://duolingo.atlassian.net/browse/${key}`
  return `/issue?ref=${encodeURIComponent(key)}`
}

export const refFromHref = (href: string): string | null => {
  const url = href.replace(/^https:\/\/duo\.fyi\/ink\//, "")
  const jira = url.match(/^https:\/\/[\w.-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]{1,9}-\d+)(?=$|[/?#])/)
  if (jira) return jira[1]!
  const github = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)(?=$|[/?#])/i)
  return github ? `${github[1]}#${github[2]}` : null
}

export const classifyRef = (text: string, href?: string) => {
  const ref = (href && refFromHref(href)) || text
  const github = ref.match(/^(?:([\w.-]+(?:\/[\w.-]+)?))?#(\d+)$/)
  return {
    kind: /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(ref) ? "jira" : github?.[1] ? "github" : "tracker",
    ref,
    href: ticketUrl(ref, href),
    repo: github?.[1],
    number: github?.[2],
  }
}

// The reader accepts only numbers for GitHub, scoped to the selected tracker.
export const ticketLookupRef = (ref: ReturnType<typeof classifyRef>, repo?: string): string | undefined => {
  if (!ref.repo) return ref.number ?? ref.ref
  if (!repo || !repo.includes("/")) return undefined
  const match = ref.repo.includes("/") ? repo : repo.split("/")[1]!
  return match.toLowerCase() === ref.repo.toLowerCase() ? ref.number : undefined
}

export const ticketMatchesRef = (text: string, issue: { ref: string; number: number | null; url: string }): boolean => {
  const ref = classifyRef(text)
  if (!ref.number) return ref.ref === issue.ref
  if (Number(ref.number) !== issue.number) return false
  if (!ref.repo) return true
  const actual = classifyRef(refFromHref(issue.url) ?? "")
  return actual.number === ref.number && ticketLookupRef(ref, actual.repo) !== undefined
}
