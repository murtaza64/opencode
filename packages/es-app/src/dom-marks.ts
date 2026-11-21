import { onCleanup, onMount } from "solid-js"

/* Ancestor and sibling state that CSS once read with `:has()`. Chrome re-evaluates every `:has()` rule on each
 * DOM mutation that could change it, which made every streamed text delta restyle ~1.5k elements. Components
 * that know their own state set these attributes instead (harness-perf, stream-latency.mjs). */

/** Marks the closest `selector` ancestor of `el` with `data-<name>` while at least one marked element is mounted
 * inside it; `also` marks that ancestor's parent too (for rules on its earlier siblings). */
export const markAncestor = (el: () => HTMLElement | undefined, selector: string, name: string, also = false) =>
  mark(() => el()?.closest<HTMLElement>(selector) ?? undefined, name, also)

/** Marks `el`'s parent, when it matches `selector`, like `markAncestor` (for `:has(> child)` rules). */
export const markParent = (el: () => HTMLElement | undefined, selector: string, name: string) =>
  mark(() => { const parent = el()?.parentElement; return parent?.matches(selector) ? parent : undefined }, name)

const mark = (find: () => HTMLElement | undefined, name: string, also = false) => {
  onMount(() => {
    const host = find()
    if (!host) return
    const targets = also && host.parentElement ? [host, host.parentElement] : [host]
    const key = `data-${name}`
    for (const target of targets) target.setAttribute(key, String(Number(target.getAttribute(key) ?? 0) + 1))
    onCleanup(() => {
      for (const target of targets) {
        const left = Number(target.getAttribute(key) ?? 1) - 1
        if (left > 0) target.setAttribute(key, String(left))
        else target.removeAttribute(key)
      }
    })
  })
}

/** Input handlers that mirror the input's `:focus-visible` onto its parent label as `data-focus-visible`. */
export const focusRing = {
  onFocus: (event: FocusEvent) => {
    const input = event.currentTarget as HTMLElement
    input.parentElement?.toggleAttribute("data-focus-visible", input.matches(":focus-visible"))
  },
  onBlur: (event: FocusEvent) => (event.currentTarget as HTMLElement).parentElement?.removeAttribute("data-focus-visible"),
}
