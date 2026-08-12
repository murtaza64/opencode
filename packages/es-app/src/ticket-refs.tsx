/* Ticket-ref hover cards: agents cite tickets bare (SD-123, dotfiles#77, #77)
 * with no context — wrap refs found in the rendered transcript and show
 * tracker info on hover, with links to the in-app ticket page and the
 * external tracker (jira/github). */
import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { es, type IssueDetail } from "./api"
import { ago, linkUrl, useDashboard } from "./state"
import { IssueChips } from "./pages/issue"

const JIRA_BASE = "https://duolingo.atlassian.net/browse/"

// SD-123 / DLAA-31571 (jira) · owner/repo#12 · dotfiles#77 · bare #77
const REF_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b|(?:\b[\w.-]+\/)?(?:\b[\w.-]+)?#\d+(?![\w-])/g

type RefKind = "jira" | "github" | "tracker"

export function classifyRef(text: string): { kind: RefKind; ref: string; href?: string } {
  if (/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(text)) return { kind: "jira", ref: text, href: JIRA_BASE + text }
  const m = text.match(/^(?:([\w.-]+\/[\w.-]+))?(?:[\w.-]*)#(\d+)$/)
  if (m?.[1]) return { kind: "github", ref: text, href: `https://github.com/${m[1]}/issues/${m[2]}` }
  // bare #N or name#N: resolve against the editspace tracker
  return { kind: "tracker", ref: text.slice(text.indexOf("#") + 1) }
}

/* Wrap ticket refs found in text nodes under root. Idempotent: already
 * wrapped refs (and anchors, which the ink rewrite owns) are skipped, so the
 * MutationObserver that calls this converges. */
export function wrapTicketRefs(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement
      if (!p || p.closest("a, .ticket-ref, textarea, script, style")) return NodeFilter.FILTER_REJECT
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
  const { editspace } = useDashboard()
  // anchor = the hovered ref element; measured lazily so transcript auto-pin
  // scrolls reposition the card instead of killing it
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null)
  const [tick, setTick] = createSignal(0)
  let hideTimer: ReturnType<typeof setTimeout> | undefined

  const show = (el: HTMLElement) => {
    clearTimeout(hideTimer)
    setAnchor(el)
  }
  const scheduleHide = () => {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => setAnchor(null), 200)
  }

  onMount(() => {
    const over = (e: Event) => {
      const el = (e.target as Element | null)?.closest?.(".ticket-ref")
      if (el instanceof HTMLElement) show(el)
    }
    const out = (e: Event) => {
      if ((e.target as Element | null)?.closest?.(".ticket-ref")) scheduleHide()
    }
    const reposition = () => {
      const el = anchor()
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
    c.addEventListener("scroll", reposition, { passive: true })
    onCleanup(() => {
      c.removeEventListener("mouseover", over)
      c.removeEventListener("mouseout", out)
      c.removeEventListener("scroll", reposition)
      clearTimeout(hideTimer)
    })
  })

  const info = () => {
    const el = anchor()
    return el ? classifyRef(el.dataset.ticket ?? "") : null
  }

  const [detail] = createResource(
    () => {
      const i = info()
      return i?.kind === "tracker" ? { ref: i.ref, es: editspace() } : null
    },
    (src) => {
      const key = `${src.es ?? ""}\u0000${src.ref}`
      let p = detailCache.get(key)
      if (!p) {
        p = es.issue(src.ref, src.es)
        detailCache.set(key, p)
        p.catch(() => detailCache.delete(key)) // don't cache flakes
      }
      return p
    },
  )

  const pos = () => {
    tick() // re-measure on container scroll
    const r = anchor()!.getBoundingClientRect()
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
        <Show when={info()?.kind === "tracker"} fallback={
          <div class="tip-row">
            <span class="mono">{anchor()!.dataset.ticket}</span>
            <a href={linkUrl(info()!.href!)} target="_blank">
              open in {info()?.kind === "jira" ? "jira" : "github"} ↗
            </a>
          </div>
        }>
          <Show when={detail()} fallback={<div class="dim">{detail.error ? `no ticket info (${anchor()!.dataset.ticket})` : "loading…"}</div>}>
            {(doc) => (
              <>
                <div class="tip-title">
                  <span class="issue-num">#{doc().number ?? doc().ref}</span> {doc().title}
                </div>
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
                      {doc().backend === "gh" ? "github ↗" : "open ↗"}
                    </a>
                  </Show>
                </div>
              </>
            )}
          </Show>
        </Show>
      </div>
    </Show>
  )
}
