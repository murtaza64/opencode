import { useRadioGroupContext } from "@kobalte/core/radio-group"
import { SegmentedControl as Kobalte } from "@kobalte/core/segmented-control"
import { createSignal, For, splitProps } from "solid-js"
import type { ComponentProps, JSX } from "solid-js"

export type RadioGroupProps<T> = Omit<
  ComponentProps<typeof Kobalte>,
  "value" | "defaultValue" | "onChange" | "children"
> & {
  options: T[]
  current?: T
  defaultValue?: T
  value?: (x: T) => string
  label?: (x: T) => JSX.Element | string
  onSelect?: (value: T | undefined) => void
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
  size?: "small" | "medium"
  fill?: boolean
  pad?: "none" | "normal"
}

export function RadioGroup<T>(props: RadioGroupProps<T>) {
  const [local, others] = splitProps(props, [
    "class",
    "classList",
    "options",
    "current",
    "defaultValue",
    "value",
    "label",
    "onSelect",
    "size",
    "fill",
    "pad",
  ])

  const getValue = (item: T): string => {
    if (local.value) return local.value(item)
    return String(item)
  }

  const getLabel = (item: T): JSX.Element | string => {
    if (local.label) return local.label(item)
    return String(item)
  }

  const findOption = (v: string): T | undefined => {
    return local.options.find((opt) => getValue(opt) === v)
  }

  return (
    <Kobalte
      {...others}
      data-component="radio-group"
      data-size={local.size ?? "medium"}
      data-fill={local.fill ? "" : undefined}
      data-pad={local.pad ?? "normal"}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      value={local.current ? getValue(local.current) : undefined}
      defaultValue={local.defaultValue ? getValue(local.defaultValue) : undefined}
      onChange={(v) => local.onSelect?.(findOption(v))}
    >
      <Wrapper values={local.options.map(getValue)}>
        <Kobalte.Indicator data-slot="radio-group-indicator" />
        <div role="presentation" data-slot="radio-group-items">
          <For each={local.options}>
            {(option) => (
              <Kobalte.Item value={getValue(option)} data-slot="radio-group-item" data-value={getValue(option)}>
                <Kobalte.ItemInput data-slot="radio-group-item-input" />
                <Kobalte.ItemLabel data-slot="radio-group-item-label">
                  <span data-slot="radio-group-item-control">{getLabel(option)}</span>
                </Kobalte.ItemLabel>
              </Kobalte.Item>
            )}
          </For>
        </div>
      </Wrapper>
    </Kobalte>
  )
}

// Mirrors the checked and focus-visible state of its items, so radio-group.css needs no `:has()`.
function Wrapper(props: { values: string[]; children: JSX.Element }) {
  const group = useRadioGroupContext()
  const [focusVisible, setFocusVisible] = createSignal(false)
  return (
    <div
      role="presentation"
      data-slot="radio-group-wrapper"
      data-item-checked={props.values.some((value) => group.isSelectedValue(value)) ? "" : undefined}
      data-item-focus-visible={focusVisible() ? "" : undefined}
      onFocusIn={(e) => setFocusVisible((e.target as HTMLElement).matches('[data-slot="radio-group-item-input"]:focus-visible'))}
      onFocusOut={() => setFocusVisible(false)}
    >
      {props.children}
    </div>
  )
}
