/* Baymax-style PR rows: crust background row, octicon PR-state icon
 * (open/draft/merged/closed), diff stats, and flat metadata badges — approved
 * check, pending-reviewer names, per-check CI symbols. Wraps for the narrow
 * info panel. */
import { For, Index, Show } from "solid-js"

// GitHub Octicons (16px) paths, via baymax
const ICON_PATHS: Record<string, string> = {
  open: "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
  draft:
    "M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z",
  merged:
    "M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z",
  closed:
    "M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z",
}
const CHECK_PATH =
  "M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"
const CIRCLE_CHECK_PATH =
  "M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm3.78 6.22-4.25 4.25a.75.75 0 0 1-1.06 0L4.22 8.22a.75.75 0 0 1 1.06-1.06L7 8.88l3.72-3.72a.75.75 0 1 1 1.06 1.06Z"
const X_PATH =
  "M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"
const DOT_PATH = "M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"
const PERSON_ADD_PATH =
  "M7.9 8.548h-.001a5.528 5.528 0 0 1 3.1 4.659.75.75 0 1 1-1.498.086A4.01 4.01 0 0 0 5.5 9.5a4.01 4.01 0 0 0-4.001 3.793.75.75 0 1 1-1.498-.085 5.527 5.527 0 0 1 3.1-4.66 3.5 3.5 0 1 1 4.799 0ZM13.25 0a.75.75 0 0 1 .75.75V2h1.25a.75.75 0 0 1 0 1.5H14v1.25a.75.75 0 0 1-1.5 0V3.5h-1.25a.75.75 0 0 1 0-1.5h1.25V.75a.75.75 0 0 1 .75-.75ZM5.5 4a2 2 0 1 0-.001 3.999A2 2 0 0 0 5.5 4Z"

function Icon(props: { path: string; size?: number; class?: string; title?: string }) {
  return (
    <svg
      class={props.class}
      width={props.size ?? 14}
      height={props.size ?? 14}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <title>{props.title}</title>
      <path d={props.path} />
    </svg>
  )
}

export const prState = (pr: any): "open" | "draft" | "merged" | "closed" => {
  if (pr.state === "merged") return "merged"
  if (pr.state === "closed") return "closed"
  return pr.isDraft ? "draft" : "open"
}

const isOpen = (pr: any) => prState(pr) === "open" || prState(pr) === "draft"

/** open/draft first, then merged, then closed — each newest first */
export function sortPrs(prs: any[]): any[] {
  const order: Record<string, number> = { open: 0, draft: 0, merged: 1, closed: 2 }
  return [...prs].sort(
    (a, b) =>
      order[prState(a)]! - order[prState(b)]! ||
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  )
}

export function Pr(props: { pr: any; compact?: boolean }) {
  const pr = () => props.pr
  const approvals = () => (pr().reviews ?? []).filter((r: any) => r.state === "APPROVED")
  const rejections = () => (pr().reviews ?? []).filter((r: any) => r.state === "CHANGES_REQUESTED")
  const requested = () => pr().review_requested ?? []
  const cap = (n: number) => Math.min(n, 5)
  return (
    <a class="pr-title-row" href={pr().url} target="_blank" rel="noopener noreferrer" title={pr().title}>
      <span class="pr-key-group">
        <Icon class={`pr-icon icon-${prState(pr())}`} path={ICON_PATHS[prState(pr())]!} size={16} />
        <span class="pr-number">
          {props.compact ? pr().repo.split("/")[1] : pr().repo}#{pr().number}
        </span>
      </span>

      <Show when={pr().additions != null || pr().deletions != null}>
        <span class="pr-diff-stats">
          <span class="additions">+{pr().additions ?? 0}</span>
          <span class="deletions">-{pr().deletions ?? 0}</span>
        </span>
      </Show>

      <Show when={pr().mergeable === "CONFLICTING" && isOpen(pr())}>
        <span class="pr-metadata-badge conflicts">CONFLICTS</span>
      </Show>

      <Show when={isOpen(pr()) && approvals().length}>
        <span
          class="pr-metadata-badge approved-icon"
          title={`Approved: ${approvals()
            .map((r: any) => r.login)
            .join(", ")}`}
        >
          <Icon path={CIRCLE_CHECK_PATH} />
        </span>
      </Show>

      <Show when={isOpen(pr()) && rejections().length}>
        <span class="pr-metadata-badge changes-requested" title="Changes requested">
          ✗ {rejections()
            .map((r: any) => r.login)
            .join(", ")}
        </span>
      </Show>

      <Show when={isOpen(pr()) && requested().length}>
        <span class="pr-metadata-badge pending-reviews" title={`Awaiting review: ${requested().join(", ")}`}>
          <Icon path={PERSON_ADD_PATH} class="pending-review-icon" />
          <span class="pending-review-text">{requested().join(", ")}</span>
        </span>
      </Show>

      <Show when={isOpen(pr())}>
        <span class="ci-symbol-group">
          <Show when={pr().ci_pending > 0}>
            <span class="pr-metadata-badge ci-pending ci-symbol" title={`${pr().ci_pending} pending checks`}>
              <Index each={Array(cap(pr().ci_pending))}>{() => <Icon path={DOT_PATH} size={12} />}</Index>
            </span>
          </Show>
          <Show when={pr().ci_failing > 0}>
            <span class="pr-metadata-badge ci-failing ci-symbol" title={`${pr().ci_failing} failing checks`}>
              <Index each={Array(cap(pr().ci_failing))}>{() => <Icon path={X_PATH} size={12} />}</Index>
            </span>
          </Show>
          <Show when={pr().ci === "passing"}>
            <span class="pr-metadata-badge ci-passing" title="Checks passing">
              <Icon path={CHECK_PATH} />
            </span>
          </Show>
        </span>
      </Show>

      <Show when={isOpen(pr()) && pr().autoMerge}>
        <span class="pr-metadata-badge auto-merge">AUTO-MERGE</span>
      </Show>
    </a>
  )
}

export function PrList(props: { prs: any[]; compact?: boolean }) {
  return <For each={sortPrs(props.prs)}>{(p) => <Pr pr={p} compact={props.compact} />}</For>
}
