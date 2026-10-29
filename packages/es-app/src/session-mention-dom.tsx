import { createEffect, onCleanup, onMount } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { linkUrl, sessionHref, useDashboard } from "./state"

const REF = /@?ses_[A-Za-z0-9]{26}(?![A-Za-z0-9])/g

export const wrapSessionRefs = (root: HTMLElement) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // The regex first; closest() runs only for the rare text node that has a session ID. A session's own header
      // title is plain text, never a chip pointing at itself.
      REF.lastIndex = 0
      if (!REF.test(node.nodeValue ?? "")) return NodeFilter.FILTER_SKIP
      return !node.parentElement || node.parentElement.closest("pre, code, textarea, select, script, style, .session-ref, .ticket-ref, .context-picker, .context-chips, .session-chip, .session-title")
        ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT
    },
  })
  const targets: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) targets.push(node as Text)
  for (const text of targets) {
    const value = text.nodeValue ?? ""
    const fragment = document.createDocumentFragment()
    let last = 0
    REF.lastIndex = 0
    for (let match = REF.exec(value); match; match = REF.exec(value)) {
      fragment.append(document.createTextNode(value.slice(last, match.index)))
      const span = document.createElement("span")
      span.className = "session-ref"
      span.dataset.session = match[0].replace(/^@/, "")
      span.textContent = match[0]
      fragment.append(span)
      last = match.index + match[0].length
    }
    fragment.append(document.createTextNode(value.slice(last)))
    text.replaceWith(fragment)
  }
}

export const SessionRefs = (props: { container: () => HTMLElement | undefined }) => {
  const { sessionRows } = useDashboard()
  const navigate = useNavigate()
  const location = useLocation()
  const resolve = () => {
    const rows = sessionRows()
    const current = /^\/session\/(ses_[^/]+)/.exec(location.pathname)?.[1]
    for (const el of props.container()?.querySelectorAll<HTMLElement>(".session-ref") ?? []) {
      const id = el.dataset.session!
      const row = rows.find((row) => row.id === id)
      const kind = id === current ? "current" : row ? "resolved" : "unknown"
      // Idempotent: re-decorating is itself a DOM mutation that re-triggers the
      // shell observer, so an unstable check here becomes a rAF-rate loop.
      if (el.dataset[kind] === "1" && el.dataset.title === (row?.title ?? "")) continue
      delete el.dataset.resolved
      delete el.dataset.current
      delete el.dataset.unknown
      el.dataset[kind] = "1"
      el.dataset.title = row?.title ?? ""
      el.title = row ? `${row.title || row.id} — ${row.project ?? row.directory}` : id
      const original = el.querySelector(".session-ref-id")?.textContent ?? el.textContent ?? ""
      const hidden = document.createElement("span")
      hidden.className = "session-ref-id"
      hidden.textContent = original
      const label = document.createElement("span")
      label.className = "session-ref-label"
      label.textContent = kind === "current" ? "this session" : `@${row?.title || id}`
      label.setAttribute("aria-hidden", "true")
      el.replaceChildren(hidden, label)
    }
  }
  createEffect(resolve)
  onMount(() => {
    const container = props.container()
    if (!container) return
    container.addEventListener("session-refs-wrapped", resolve)
    const click = (event: MouseEvent) => {
      const el = (event.target as Element).closest<HTMLElement>(".session-ref[data-resolved]")
      if (!el || !container.contains(el)) return
      const row = sessionRows().find((row) => row.id === el.dataset.session)
      if (!row) return
      event.preventDefault()
      event.stopPropagation()
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button === 1) {
        window.open(linkUrl(sessionHref(row.id, row.directory)), "_blank")
        return
      }
      navigate(sessionHref(row.id, row.directory))
    }
    container.addEventListener("click", click)
    container.addEventListener("auxclick", click)
    onCleanup(() => {
      container.removeEventListener("session-refs-wrapped", resolve)
      container.removeEventListener("click", click)
      container.removeEventListener("auxclick", click)
    })
  })
  return null
}
