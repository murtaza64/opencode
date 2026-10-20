import { createSignal, For, onCleanup, Show, type JSX } from "solid-js"

// WAI-ARIA menu button. Kobalte's DropdownMenu trigger loops forever in
// scrollIntoViewport when the page root has overflow:hidden and the trigger
// sits in a scrollable ancestor (the web session layout), so this stays local.
export type HeaderMenuItem = { label: string; select: () => void }

export const HeaderMenu = (props: { id: string; label: string; title?: string; icon: JSX.Element; items: HeaderMenuItem[] }) => {
  const [open, setOpen] = createSignal(false)
  let trigger: HTMLButtonElement | undefined
  let menu: HTMLDivElement | undefined
  const items = () => [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
  const focusItem = (index: number) => {
    const list = items()
    list[(index + list.length) % list.length]?.focus()
  }
  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) trigger?.focus({ preventScroll: true })
  }
  const show = (index: number) => {
    setOpen(true)
    queueMicrotask(() => focusItem(index))
  }
  const outside = (event: PointerEvent) => {
    if (!open() || !(event.target instanceof Node)) return
    if (menu?.contains(event.target) || trigger?.contains(event.target)) return
    close(false)
  }
  document.addEventListener("pointerdown", outside, true)
  onCleanup(() => document.removeEventListener("pointerdown", outside, true))
  return <span class="header-menu">
    <button ref={trigger} class="header-icon" aria-label={props.label} title={props.title} aria-haspopup="menu"
      aria-expanded={open()} aria-controls={open() ? props.id : undefined}
      onClick={() => open() ? close(false) : show(0)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
        event.preventDefault()
        show(event.key === "ArrowUp" ? -1 : 0)
      }}>{props.icon}</button>
    <Show when={open()}>
      <div ref={menu} id={props.id} class="header-menu-list" role="menu" aria-label={props.label}
        onKeyDown={(event) => {
          const index = items().indexOf(document.activeElement as HTMLButtonElement)
          const step = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: -1 }[event.key]
          if (step !== undefined) {
            event.preventDefault()
            focusItem(step)
            return
          }
          if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            close(true)
            return
          }
          if (event.key === "Tab") close(false)
        }}>
        <For each={props.items}>{(item) =>
          <button role="menuitem" tabIndex={-1} onClick={() => { close(true); item.select() }}>{item.label}</button>
        }</For>
      </div>
    </Show>
  </span>
}
