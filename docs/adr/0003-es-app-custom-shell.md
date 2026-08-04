# es-app: custom shell composing UI packages, not a packages/app patch

Status: accepted (grilled 2026-08-04, light grill in api-testing session)

## Decision

The editspace-native frontend is a **new fork package `packages/es-app`**:
a Solid+Vite browser shell importing `@opencode-ai/sdk` (transport),
`@opencode-ai/session-ui` and `@opencode-ai/ui` (transcript rendering),
with the es dashboard's Python server (dotfiles `bin/es-dashboard`, :7777)
as the editspace-data API. The dashboard's attention-queue/thread view
becomes the shell's home screen.

## Alternatives rejected

- **Fork-patch `packages/app`** (teach it `/umbrella/session`, add
  editspace chips): cheapest, chat already works — but its chrome and
  multi-server data model constrain editspace-native structure (threads,
  tickets, attention queue as the organizing principle), and every patch
  lives inside the fastest-moving upstream package. Kept as the fallback
  if the spike gate fails.
- **Deep-link glue** (dashboard links into the served app at :4096): two
  disjoint UIs; fails the "one place" goal.
- **Hand-rolled frontend** (extend the dashboard's vanilla-JS page into a
  chat client): reimplements message-part rendering, streaming markdown,
  and diff views that `session-ui` already provides with storybook
  coverage.

## Why this is safe enough

The hard, churn-prone surface (transcript rendering, SDK) is consumed as
workspace packages, not copied. The shell itself is fork-only chrome —
upstream rebases don't touch it, only its imports' APIs. Chosen for
maximal flexibility: the shell owns layout and can absorb the dashboard,
tracker views, and later spawn/orchestration UI without fighting app
chrome.

## Gate

Before building: a ~1-day spike rendering one real transcript with
`session-ui` outside `packages/app`'s providers. Entanglement beyond
extraction flips the decision to the packages/app patch alternative.
