export const prFromHref = (href: string) => {
  const url = href.replace(/^https:\/\/duo\.fyi\/ink\//i, "")
  const m = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?=[/?#]|$)/i)
  if (!m) return null
  return {
    repo: m[1]!.toLowerCase(),
    number: Number(m[2]),
    url: `https://github.com/${m[1]!.toLowerCase()}/pull/${Number(m[2])}`,
  }
}

export const matchPrRef = (ref: string, urls: Iterable<string>, href?: string) => {
  if (href) return prFromHref(href)
  const m = ref.match(/^([\w.-]+(?:\/[\w.-]+)?)#(\d+)$/)
  if (!m) return null
  const repo = m[1]!.toLowerCase()
  const matches = new Map<string, NonNullable<ReturnType<typeof prFromHref>>>()
  for (const url of urls) {
    const pr = prFromHref(url)
    if (!pr || (pr.repo !== repo && pr.repo.split("/")[1] !== repo)) continue
    matches.set(pr.url, pr)
  }
  // A short repo name must identify one owner, even across different PR numbers.
  if (new Set([...matches.values()].map((pr) => pr.repo)).size !== 1) return null
  return [...matches.values()].find((pr) => pr.number === Number(m[2])) ?? null
}
