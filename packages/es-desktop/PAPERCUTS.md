# Papercuts

- 2026-09-16: A fresh lane-local `bun install` left Electron's `path.txt` missing; run `node node_modules/electron/install.js` from this package before native tests if the binary install has not finished.
- 2026-09-16: Bun's HTTP implementation closes the listener in `closeAllConnections()`. Register `server.close()` first; the reverse order raises `ERR_SERVER_NOT_RUNNING` during test cleanup.
- 2026-09-16: Repeated foreground Electron installs still left a partial extraction; running the same installer in a dedicated tmux session completed it.
- 2026-09-16: Vite 7 treats `port: 0` as its default port, then searches for a free port. The desktop gateway and fixture use actual OS-assigned ports.
- 2026-09-16: electron-builder falls back to collecting root workspace dependencies when the shell has no runtime dependencies. Explicitly exclude `node_modules` from the packaged app.
