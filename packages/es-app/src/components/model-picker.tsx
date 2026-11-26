import { createEffect, createMemo, createSignal, createUniqueId, For, onMount, Show } from "solid-js"
import { modelCatalog, modelMatches, modelKey, type ModelChoice, type ModelProvider } from "../model-picker"
import "./model-picker.css"

export const ModelPicker = (props: {
  providers: ModelProvider[]
  selected?: ModelChoice | null
  label: string
  loading?: boolean
  inheritedLabel?: string
  onChoose: (model: ModelChoice | null) => void
  onClose: () => void
}) => {
  const id = createUniqueId()
  const [query, setQuery] = createSignal("")
  const [provider, setProvider] = createSignal("")
  const [images, setImages] = createSignal(false)
  const [active, setActive] = createSignal(0)
  let dialog!: HTMLDialogElement
  let search!: HTMLInputElement
  const catalog = createMemo(() => modelCatalog(props.providers, props.selected))
  const results = createMemo(() => catalog().filter((model) =>
    (!provider() || model.providerID === provider()) && (!images() || model.image === true) && modelMatches(model, query())))
  const options = createMemo(() => [
    ...(props.inheritedLabel && !provider() && !images() && (!query().trim() || props.inheritedLabel.toLowerCase().includes(query().trim().toLowerCase()))
      ? [{ key: "inherited", name: props.inheritedLabel, model: null }] : []),
    ...results().map((model) => ({ key: model.key, name: model.name, model })),
  ])
  createEffect(() => { options(); setActive(0) })
  const activate = (index: number) => {
    setActive(index)
    document.getElementById(`${id}-option-${index}`)?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }
  const choose = (index: number) => {
    const option = options()[index]
    if (!option) return
    props.onChoose(option.model ? { providerID: option.model.providerID, modelID: option.model.modelID } : null)
  }
  onMount(() => { dialog.showModal(); search.focus({ preventScroll: true }) })

  return <dialog ref={dialog} class="model-picker" data-ticket-refs="off" aria-labelledby={`${id}-title`} aria-describedby={`${id}-help`}
    onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === "Escape") { event.preventDefault(); props.onClose() }
    }}
    onClose={props.onClose} onCancel={(event) => { event.preventDefault(); props.onClose() }}
    onClick={(event) => { if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) props.onClose()
    } }}>
    <header><div><h2 id={`${id}-title`}>{props.label}</h2><p id={`${id}-help`}>Choose a model for {props.inheritedLabel === "Use session model" ? "this Aside only" : "future turns"}.</p></div>
      <button type="button" onClick={props.onClose} aria-label="Close model picker">Esc</button></header>
    <input ref={search} type="search" placeholder="Search models, providers, or API IDs…" aria-label="Search models"
      role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-results`}
      aria-activedescendant={options().length ? `${id}-option-${active()}` : undefined}
      value={query()} onInput={(event) => setQuery(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.isComposing) return
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); event.stopPropagation()
          if (options().length) activate((active() + (event.key === "ArrowDown" ? 1 : -1) + options().length) % options().length)
        }
        if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); choose(active()) }
      }} />
    <div class="model-picker-filters" role="group" aria-label="Filter by provider">
      <button type="button" aria-pressed={!provider()} onClick={() => setProvider("")}>All providers</button>
      <For each={props.providers}>{(item) => <button type="button" aria-pressed={provider() === item.id} onClick={() => setProvider(item.id)}><bdi>{item.name || item.id}</bdi></button>}</For>
    </div>
    <div class="model-picker-summary"><span role="status">{props.loading ? "Loading models…" : `${results().length} models`}</span>
      <label><input type="checkbox" checked={images()} onChange={(event) => setImages(event.currentTarget.checked)} />Image input</label></div>
    <div class="model-picker-results" id={`${id}-results`} role="listbox" aria-label="Models">
      <For each={options()}>{(option, index) => <div role="option" id={`${id}-option-${index()}`} tabIndex={-1}
        aria-selected={option.model ? option.key === modelKey(props.selected) : !props.selected}
        class="model-picker-option" data-active={active() === index() ? "" : undefined}
        onMouseDown={(event) => event.preventDefault()} onClick={() => choose(index())}>
        <div class="model-picker-option-name"><bdi>{option.name}</bdi><span>
          <Show when={option.model ? option.key === modelKey(props.selected) : !props.selected}><small>Selected</small></Show>
          <Show when={option.model?.quick}><small>Quick pick</small></Show>
        </span></div>
        <Show when={option.model}>{(model) => <>
          <div class="model-picker-option-id"><bdi>{model().providerName}</bdi><span> · </span><bdi dir="ltr">{model().modelID}</bdi></div>
          <Show when={model().image === true}><span class="model-picker-capability">Image input</span></Show>
          <Show when={model().unavailable}><span class="model-picker-capability">Current model · not in this catalog</span></Show>
        </>}</Show>
      </div>}</For>
      <Show when={!options().length}><p class="model-picker-empty">{props.loading ? "Loading catalog…" : "No matching models. Try fewer words or another filter."}</p></Show>
    </div>
    <footer><span>↑ ↓ to browse · Enter to choose</span><button type="button" onClick={props.onClose}>Cancel</button></footer>
  </dialog>
}
