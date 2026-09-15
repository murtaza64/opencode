# Papercuts

- 2026-09-15: Verifying the upstream merge, `packages/es-app` production build failed because Vite's default IIFE worker format cannot bundle the diff worker's split chunks. Set `worker.format` to `es`.
- 2026-09-15: The fork install script points agents at `.editspace/AGENTS.md`, but this checkout has no sidecar. Verification used an isolated jj workspace; the global install and daemon were left untouched.
