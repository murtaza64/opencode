import { createResource, createSignal, For, Show } from "solid-js"
import { ago } from "../state"
import { archive, ArchiveFailure, isSummary, type ArchiveDoc } from "../desk-archive"

/** The archive beside the hot notes: topic docs and session summaries, searchable; view, edit, create and delete one
 * doc at a time. Read when opened, never polled. A dashboard without the archive says so and offers nothing. */
export const ArchivePanel = () => {
  const [open, setOpen] = createSignal(false)
  // Failures are a value, not a thrown resource error: the panel says what happened and keeps rendering.
  const [listed, { refetch }] = createResource(open, () => archive.list().then(docs => ({ docs }), (cause: unknown) => ({ error: cause instanceof ArchiveFailure ? cause : new ArchiveFailure(String(cause)) })))
  const docs = () => { const value = listed(); return value && "docs" in value ? value.docs : undefined }
  const listError = () => { const value = listed(); return value && "error" in value ? value.error : undefined }
  const [query, setQuery] = createSignal("")
  const [hits] = createResource(() => open() && query().trim().length >= 2 ? query().trim() : undefined, (q: string) => archive.search(q).catch(() => []))
  const [doc, setDoc] = createSignal<ArchiveDoc>()
  const [draft, setDraft] = createSignal<string>()
  const [created, setCreated] = createSignal({ slug: "", text: "" })
  const [notice, setNotice] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const failure = (cause: unknown) => cause instanceof ArchiveFailure ? cause : new ArchiveFailure(String(cause))
  const absent = () => !!listError()?.absent
  /** `keep`: after a change, so its outcome stays visible. */
  const show = async (slug: string, keep = false) => {
    if (!keep) setNotice("")
    setDraft()
    try { setDoc(await archive.read(slug)) } catch (cause) { setNotice(`Could not read ${slug}: ${failure(cause).message}`) }
  }
  // One change at a time; a 409 means the doc changed since it was read: it is re-read and nothing is overwritten.
  const act = async (run: () => Promise<unknown>, done: string, slug: string) => {
    setBusy(true)
    setNotice("")
    try {
      await run()
      setNotice(done)
      return true
    } catch (cause) {
      const error = failure(cause)
      setNotice(error.conflict ? `${slug} changed since it was read; showing the current text. Nothing was overwritten.` : `Not saved: ${error.message}`)
      if (error.conflict) await show(slug, true).catch(() => undefined)
      return false
    } finally {
      setBusy(false)
      void refetch()
    }
  }
  const save = async () => {
    const current = doc()!
    if (await act(() => archive.save(current.slug, draft()!, current.sha256), `Saved ${current.slug}.`, current.slug)) await show(current.slug, true)
  }
  const remove = async () => {
    const current = doc()!
    if (!confirm(`Delete ${current.path}? It stays in the archive's git history.`)) return
    if (await act(() => archive.remove(current.slug, current.sha256), `Deleted ${current.slug}.`, current.slug)) setDoc()
  }
  const add = async () => {
    const value = created()
    if (await act(() => archive.save(value.slug.trim(), value.text, ""), `Created ${value.slug.trim()}.`, value.slug.trim())) {
      setCreated({ slug: "", text: "" })
      await show(value.slug.trim(), true)
    }
  }
  const list = (summaries: boolean) => (docs() ?? []).filter(item => isSummary(item.slug) === summaries).toSorted((a, b) => b.updated - a.updated)
  const row = (item: { slug: string; path: string }, meta: string) =>
    <li data-archive-slug={item.slug}><button type="button" class="link-button" aria-current={doc()?.slug === item.slug ? "true" : undefined}
      onClick={() => void show(item.slug)}><code class="desk-archive-slug" dir="ltr">{item.slug}</code></button> <span class="home-source">{meta}</span></li>
  return <details class="desk-memory-history desk-archive" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Archive{docs() ? ` (${docs()!.length})` : ""}</summary>
    <Show when={!absent()} fallback={<p class="home-muted">This dashboard has no memory archive.</p>}>
      <Show when={listError() && !absent()}><p class="home-warning" role="status">Archive could not be read: {listError()!.message}</p></Show>
      <Show when={notice()}><p class="home-source" role="status">{notice()}</p></Show>
      <input class="search-input" type="search" aria-label="Search the archive" placeholder="search archive…" value={query()} onInput={event => setQuery(event.currentTarget.value)} />
      <Show when={query().trim().length >= 2}>
        <ul class="desk-archive-list" aria-label="Archive search results">
          <For each={hits() ?? []} fallback={<li class="home-muted">{hits.loading ? "searching…" : "no matches"}</li>}>{hit => row(hit, "")}</For>
        </ul>
      </Show>
      <h4>Docs</h4>
      <ul class="desk-archive-list" aria-label="Archive docs">
        <For each={list(false)} fallback={<li class="home-muted">{listed.loading ? "loading…" : "No docs yet."}</li>}>{item => row(item, `${item.chars} chars · ${ago(item.updated)}`)}</For>
      </ul>
      <h4>Session summaries</h4>
      <ul class="desk-archive-list" aria-label="Session summaries">
        <For each={list(true)} fallback={<li class="home-muted">{listed.loading ? "loading…" : "No summaries yet."}</li>}>{item => row(item, ago(item.updated))}</For>
      </ul>
      <Show when={doc()}>{current => <div class="desk-archive-doc" data-archive-open={current().slug}>
        <div class="home-source"><code class="desk-archive-slug" dir="ltr">{current().path}</code></div>
        <Show when={draft() !== undefined} fallback={<pre class="desk-archive-text" dir="auto">{current().text}</pre>}>
          <textarea aria-label={`Edit ${current().slug}`} dir="auto" rows={12} value={draft()} onInput={event => setDraft(event.currentTarget.value)} />
        </Show>
        <div class="desk-memory-actions">
          <Show when={draft() !== undefined} fallback={<button class="desk-button" disabled={busy()} onClick={() => setDraft(current().text)}>Edit</button>}>
            <button class="desk-button home-primary" disabled={busy() || draft() === current().text} onClick={() => void save()}>Save</button>
            <button class="desk-button" disabled={busy()} onClick={() => setDraft()}>Cancel</button>
          </Show>
          <button class="desk-button" disabled={busy()} onClick={() => void remove()}>Delete</button>
          <button class="desk-button" onClick={() => { setDoc(); setDraft() }}>Close</button>
        </div>
      </div>}</Show>
      <form class="desk-memory-add" onSubmit={event => { event.preventDefault(); void add() }}>
        <input aria-label="New doc name" placeholder="doc name (e.g. release-flow)" value={created().slug} onInput={event => setCreated({ ...created(), slug: event.currentTarget.value })} />
        <textarea aria-label="New doc text" dir="auto" rows={3} placeholder="Markdown" value={created().text} onInput={event => setCreated({ ...created(), text: event.currentTarget.value })} />
        <button class="desk-button" type="submit" disabled={busy() || !created().slug.trim() || !created().text.trim()}>Create doc</button>
      </form>
    </Show>
  </details>
}
