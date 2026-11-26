import { createEffect, onCleanup, onMount } from "solid-js"

/**
 * Marks every `selector` ancestor of `el` with `data-<name>` while `el` is mounted and `when()` holds, counting
 * overlapping marks. Stands in for `:has()` rules, which Chrome re-evaluates on DOM mutations far from them.
 */
export function markAncestors(el: () => HTMLElement | undefined, selector: string, name: string, when: () => boolean = () => true) {
  const key = `data-${name}`
  onMount(() => {
    const hosts: HTMLElement[] = []
    for (let node = el()?.parentElement?.closest<HTMLElement>(selector); node; node = node.parentElement?.closest<HTMLElement>(selector)) hosts.push(node)
    let marked = false
    const set = (on: boolean) => {
      if (on === marked) return
      marked = on
      for (const host of hosts) {
        const count = Number(host.getAttribute(key) ?? 0) + (on ? 1 : -1)
        if (count > 0) host.setAttribute(key, String(count))
        else host.removeAttribute(key)
      }
    }
    createEffect(() => set(when()))
    onCleanup(() => set(false))
  })
}
