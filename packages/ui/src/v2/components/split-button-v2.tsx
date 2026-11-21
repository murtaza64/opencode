import { createContext, createEffect, createSignal, onCleanup, splitProps, useContext, type ComponentProps, type ParentProps } from "solid-js"
import "./split-button-v2.css"

// The root mirrors its menu trigger's `data-expanded`, so the CSS outline needs no `:has()`.
const MenuOpen = createContext<(open: boolean) => void>()

export function SplitButtonV2(props: ParentProps<ComponentProps<"div">>) {
  const [split, rest] = splitProps(props, ["class", "classList", "children"])
  const [open, setOpen] = createSignal(false)
  return (
    <MenuOpen.Provider value={setOpen}>
    <div
      data-component="split-button-v2"
      data-menu-expanded={open() ? "" : undefined}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
      {...rest}
    >
      {split.children}
    </div>
    </MenuOpen.Provider>
  )
}

export function SplitButtonV2Action(props: ComponentProps<"button">) {
  const [split, rest] = splitProps(props, ["class", "classList"])
  return (
    <button
      type="button"
      data-component="split-button-v2-action"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
      {...rest}
    />
  )
}

export function SplitButtonV2MenuTrigger(props: ComponentProps<"button">) {
  const [split, rest] = splitProps(props, ["class", "classList"])
  const setOpen = useContext(MenuOpen)
  createEffect(() => setOpen?.((props as Record<string, unknown>)["data-expanded"] !== undefined))
  onCleanup(() => setOpen?.(false))
  return (
    <button
      type="button"
      data-component="split-button-v2-menu-trigger"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
      {...rest}
    />
  )
}
