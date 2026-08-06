/* Generic markdown doc reader with branch-aware variants: shows the source's
 * default copy (trunk / editspace root) and exposes lane-workspace copies
 * that differ. Relative markdown links navigate in-app. */
import { createResource, For, Show } from "solid-js"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { es } from "../api"
import { useDashboard } from "../state"

export const docHref = (source: string, path: string, variant?: string) =>
  `/doc?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}` +
  (variant ? `&variant=${encodeURIComponent(variant)}` : "")

/** resolve an href relative to the current doc's directory; "" = not an
 * in-repo markdown link (external, anchor, non-md) */
export function resolveDocLink(currentPath: string, href: string): string {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) return ""
  const target = href.split("#")[0]
  if (!target.endsWith(".md")) return ""
  if (target.startsWith("/")) return target.slice(1)
  const dir = currentPath.split("/").slice(0, -1)
  for (const seg of target.split("/")) {
    if (seg === "." || seg === "") continue
    if (seg === "..") {
      if (!dir.length) return "" // escapes the source root
      dir.pop()
    } else dir.push(seg)
  }
  return dir.join("/")
}

export default function DocPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const { editspace } = useDashboard()
  const src = () => ({
    source: String(params.source ?? ""),
    path: String(params.path ?? ""),
    variant: String(params.variant ?? ""),
    es: editspace(),
  })
  const [doc] = createResource(src, (s) =>
    s.source && s.path ? es.doc(s.source, s.path, s.variant || undefined, s.es) : undefined,
  )

  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element).closest?.("a")
    if (!a) return
    const resolved = resolveDocLink(src().path, a.getAttribute("href") ?? "")
    if (!resolved) return
    e.preventDefault()
    navigate(docHref(src().source, resolved))
  }

  return (
    <main class="browse-page">
      <Show when={doc.error}>
        <div class="err">{String(doc.error)}</div>
      </Show>
      <Show when={doc()}>
        {(d) => (
          <>
            <div class="browse-head">
              <h1>{d().title || d().path.split("/").pop()}</h1>
              <div class="browse-meta">
                <span class="dim mono">
                  {d().source} · {d().path}
                </span>
                <span class={`chip ${d().variant ? "parked" : "plain"}`} title="which workspace's copy this is">
                  {d().variant_label}
                </span>
                <Show when={d().variants.length > 1}>
                  <span class="variant-picker">
                    <For each={d().variants}>
                      {(v) => (
                        <button
                          class={v.name === d().variant ? "selected" : ""}
                          onClick={() => setParams({ variant: v.name || undefined })}
                        >
                          {v.label}
                        </button>
                      )}
                    </For>
                  </span>
                </Show>
              </div>
            </div>
            <Show
              when={d().exists}
              fallback={
                <div class="dim">
                  This doc does not exist in {d().variant_label} — pick a lane variant above.
                </div>
              }
            >
              <div class="doc-prose" onClick={onClick}>
                <Markdown text={d().content} cacheKey={`doc:${d().source}:${d().path}:${d().variant}`} />
              </div>
            </Show>
          </>
        )}
      </Show>
    </main>
  )
}
