# Papercuts

- 2026-09-15: Verifying the upstream merge, `packages/es-app` production build failed because Vite's default IIFE worker format cannot bundle the diff worker's split chunks. Set `worker.format` to `es`.
- 2026-09-15: The fork install script points agents at `.editspace/AGENTS.md`, but this checkout has no sidecar. Verification used an isolated jj workspace; the global install and daemon were left untouched.
- 2026-09-16: Running the es-app Vite/Playwright harness directly with Bun hung before browser startup; the package's documented Node runner completed. Use `node test/*.browser.mjs`, not `bun`, for these harnesses.
- 2026-09-16: Playwright's isolated Firefox installation stalled after download, leaving a bundle missing `libmozglue.dylib`. Extracting the same CDN archive with macOS `ditto` completed the test runtime; the user's Firefox profile was not involved.
