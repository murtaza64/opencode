/* Ticket-ref hover cards: agents cite tickets bare (SD-123, dotfiles#77, #77)
 * with no context — wrap refs found anywhere in the shell (transcript,
 * sidebar, panels) and show tracker info on hover, with links to the in-app
 * ticket page and the external tracker (jira/github). */
import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { es, type IssueDetail } from "./api"
import { ago, linkUrl, useDashboard } from "./state"
import { classifyRef, refFromHref, ticketLookupRef, ticketMatchesRef } from "./ticket-url"
import { IssueChips } from "./pages/issue"
import { Pr } from "./components/pr"

// SD-123 / DLAA-31571 (jira) · owner/repo#12 · dotfiles#77 · bare #77
const REF_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b|(?:\b[\w.-]+\/)?(?:\b[\w.-]+)?#\d+(?![\w-])/g

/* PR from a link target — the href is authoritative: a repo#N text inside an
 * anchor pointing at /pull/N is a PR, not a ticket. */
export function prFromHref(href: string): { repo: string; number: number; url: string } | null {
  const url = href.replace(/^https:\/\/duo\.fyi\/ink\//, "")
  const m = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/)
  if (!m) return null
  return { repo: m[1]!, number: Number(m[2]), url: `https://github.com/${m[1]}/pull/${m[2]}` }
}

/* Wrap ticket refs found in text nodes under root — including inside anchors
 * (sidebar rows, linkified refs): the span doesn't affect navigation and the
 * hover card is still useful there. Idempotent: already wrapped refs are
 * skipped, so the MutationObserver that calls this converges. */
export function wrapTicketRefs(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement
      if (!p || p.closest(".ticket-ref, .ticket-tip, textarea, select, script, style"))
        return NodeFilter.FILTER_REJECT
      REF_RE.lastIndex = 0
      return REF_RE.test(node.nodeValue ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    },
  })
  const targets: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n as Text)

  for (const text of targets) {
    const value = text.nodeValue ?? ""
    const frag = document.createDocumentFragment()
    let last = 0
    REF_RE.lastIndex = 0
    for (let m = REF_RE.exec(value); m; m = REF_RE.exec(value)) {
      frag.appendChild(document.createTextNode(value.slice(last, m.index)))
      const span = document.createElement("span")
      span.className = "ticket-ref"
      span.dataset.ticket = m[0]
      span.textContent = m[0]
      frag.appendChild(span)
      last = m.index + m[0].length
    }
    frag.appendChild(document.createTextNode(value.slice(last)))
    text.replaceWith(frag)
  }
}

const detailCache = new Map<string, Promise<IssueDetail>>()

/* Floating hover card. Mount once per page; delegates on `container`. */
export function TicketTip(props: { container: () => HTMLElement | undefined }) {
  const { editspace, state } = useDashboard()
  // anchor = the hovered element + its resolved ticket/PR; measured lazily
  // so transcript auto-pin scrolls reposition the card instead of killing it
  type Anchor = { el: HTMLElement; ticket: string; href?: string; pr?: { repo: string; number: number; url: string } }
  const [anchor, setAnchor] = createSignal<Anchor | null>(null)
  const [tick, setTick] = createSignal(0)
  let hideTimer: ReturnType<typeof setTimeout> | undefined

  const show = (hit: Anchor) => {
    clearTimeout(hideTimer)
    setAnchor(hit)
  }
  const scheduleHide = () => {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => setAnchor(null), 200)
  }

  // Explicit ticket/PR targets take precedence over ref-shaped anchor text.
  const resolve = (e: Event): Anchor | null => {
    const t = e.target as Element | null
    const ref = t?.closest?.(".ticket-ref")
    const a = t?.closest?.("a[href]")
    const pr = a instanceof HTMLAnchorElement ? prFromHref(a.href) : null
    if (pr) {
      const el = ref instanceof HTMLElement ? ref : (a as HTMLAnchorElement)
      return { el, ticket: `${pr.repo}#${pr.number}`, pr }
    }
    if (a instanceof HTMLAnchorElement) {
      const ticket = refFromHref(a.href)
      if (ticket) return { el: ref instanceof HTMLElement ? ref : a, ticket, href: a.href }
    }
    if (ref instanceof HTMLElement) return { el: ref, ticket: ref.dataset.ticket ?? "" }
    return null
  }

  onMount(() => {
    const over = (e: Event) => {
      const hit = resolve(e)
      if (hit) show(hit)
    }
    const out = (e: Event) => {
      if (resolve(e)) scheduleHide()
    }
    const reposition = () => {
      const el = anchor()?.el
      if (!el) return
      if (!el.isConnected) return setAnchor(null)
      const r = el.getBoundingClientRect()
      if (r.bottom < 0 || r.top > window.innerHeight) return setAnchor(null)
      setTick((t) => t + 1)
    }
    const c = props.container()
    if (!c) return
    c.addEventListener("mouseover", over)
    c.addEventListener("mouseout", out)
    // capture: scrolls happen in inner scrollers (transcript, sidebar) and
    // scroll events don't bubble
    window.addEventListener("scroll", reposition, { passive: true, capture: true })
    onCleanup(() => {
      c.removeEventListener("mouseover", over)
      c.removeEventListener("mouseout", out)
      window.removeEventListener("scroll", reposition, { capture: true })
      clearTimeout(hideTimer)
    })
  })

  // known PRs from dashboard state (thread PRs + unattached) by repo+number
  const findPr = (repo: string, number: number) => {
    const st = state() as any
    if (!st) return null
    const all = [...(st.unattached_prs ?? []), ...(st.threads ?? []).flatMap((t: any) => t.prs ?? [])]
    return all.find((p: any) => p.number === number && (p.repo === repo || p.repo?.endsWith(`/${repo}`))) ?? null
  }

  /* PR resolution: an explicit /pull/ href, or a repo#N text ref matching a
   * PR the dashboard tracks. */
  const prHit = () => {
    const a = anchor()
    if (!a) return null
    if (a.pr) return { url: a.pr.url, data: findPr(a.pr.repo, a.pr.number) }
    if (a.href) return null
    const m = a.ticket.match(/^([\w.-]+(?:\/[\w.-]+)?)#(\d+)$/)
    if (!m) return null
    const found = findPr(m[1]!, Number(m[2]))
    return found ? { url: found.url as string, data: found } : null
  }

  const info = () => {
    const a = anchor()
    return a && !prHit() ? classifyRef(a.ticket, a.href) : null
  }

  const [tracker] = createResource(
    () => info()?.repo ? editspace() ?? "" : false,
    async (name) => {
      const list = await es.issues(name || undefined).catch(() => undefined)
      return { name, repo: list?.backend === "gh" ? list.repo : undefined }
    },
  )

  const detailSource = () => {
    const i = info()
    if (!i) return null
    const repo = !tracker.loading && tracker()?.name === (editspace() ?? "") ? tracker()?.repo : undefined
    const ref = ticketLookupRef(i, repo)
    return ref ? { ref, ticket: i.ref, es: editspace() } : null
  }

  const [detail] = createResource(
    detailSource,
    (src) => {
      const key = `${src.es ?? ""}\u0000${src.ref}`
      let p = detailCache.get(key)
      if (!p) {
        p = es.issue(src.ref, src.es)
        detailCache.set(key, p)
        p.catch(() => detailCache.delete(key)) // don't cache flakes
      }
      return p.then((doc) => ({ ...src, doc }))
    },
  )

  const pos = () => {
    tick() // re-measure on container scroll
    const r = anchor()!.el.getBoundingClientRect()
    // keep the card on-screen: flip above the ref when close to the bottom
    const width = 380
    const x = Math.min(r.left, window.innerWidth - width - 12)
    const below = r.bottom + 200 < window.innerHeight
    return {
      left: `${Math.max(4, x)}px`,
      ...(below ? { top: `${r.bottom + 4}px` } : { bottom: `${window.innerHeight - r.top + 4}px` }),
    }
  }

  return (
    <Show when={anchor()}>
      <div
        class="ticket-tip"
        style={pos()}
        onMouseEnter={() => clearTimeout(hideTimer)}
        onMouseLeave={scheduleHide}
      >
        {(() => {
          // Resources retain their previous value when disabled or refetching.
          const verified = () => {
            const src = detailSource()
            if (!src || detail.error || detail.loading) return undefined
            const result = detail()
            if (!result || result.ticket !== src.ticket || result.es !== src.es) return undefined
            return ticketMatchesRef(src.ticket, result.doc) ? result.doc : undefined
          }
          return (
          <Show when={!prHit()} fallback={
            <Show when={prHit()?.data} fallback={
              <div class="tip-row">
                <span class="mono">{anchor()!.ticket}</span>
                <a href={linkUrl(prHit()!.url)} target="_blank">open PR ↗</a>
              </div>
            }>
              <>
                <Show when={prHit()!.data.title}>
                  <div class="tip-title">{prHit()!.data.title}</div>
                </Show>
                <div class="tip-pr">
                  <Pr pr={prHit()!.data} />
                </div>
              </>
            </Show>
          }>
          <Show when={verified()} fallback={
            <div class="tip-row">
              <span class="mono">{anchor()!.ticket}</span>
              <Show when={info()?.href}>
                <a href={linkUrl(info()!.href!)} target="_blank">
                  {info()!.href.startsWith("/") ? "ticket page" : `open in ${info()?.kind === "jira" ? "jira" : "github"}`} ↗
                </a>
              </Show>
            </div>
          }>
            {(doc) => (
              <>
                <div class="tip-title">
                  <span class="issue-num">{doc().number != null ? `#${doc().number}` : doc().ref}</span> {doc().title}
                </div>
                <Show when={doc().status && doc().backend === "jira"}>
                  <div class="tip-row dim">{doc().status}</div>
                </Show>
                <div class="tip-row">
                  <IssueChips row={doc()} />
                </div>
                <Show when={doc().assignees?.length || doc().updated_at}>
                  <div class="tip-row dim">
                    <Show when={doc().assignees?.length}>{doc().assignees.join(", ")} · </Show>
                    <Show when={doc().updated_at}>updated {ago(Date.parse(doc().updated_at))}</Show>
                  </div>
                </Show>
                <Show when={doc().body}>
                  <div class="tip-body">{doc().body.slice(0, 280)}</div>
                </Show>
                <div class="tip-row tip-links">
                  <a href={`/issue?ref=${encodeURIComponent(doc().ref)}`}>ticket page</a>
                  <Show when={doc().url}>
                    <a href={linkUrl(doc().url)} target="_blank">
                      {doc().backend === "gh" ? "github ↗" : doc().backend === "jira" ? "jira ↗" : "open ↗"}
                    </a>
                  </Show>
                </div>
              </>
            )}
          </Show>
          </Show>
          )
        })()}
      </div>
    </Show>
  )
}
