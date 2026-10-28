/* The Pair a Phone window: one per host, sandboxed, in an in-memory session with every network
 * request refused, so the code it shows can only leave by the owner's Copy or QR scan. Its buttons
 * reach the main process as es-pair: navigations, which never load. */
import { BrowserWindow, clipboard, dialog, session } from "electron"
import { pairingView, pairingWindowPage, readPairing, rotatePairing, type PairingSource } from "./pair-phone"

const open = new Map<string, BrowserWindow>()
const guarded = { done: false }
// A copied code is cleared from the clipboard after a minute unless something else replaced it.
const CLIPBOARD_MS = 60_000

export const openPairPhone = (host: { id: string; label: string }, source: PairingSource, parent?: Electron.BaseWindow) => {
  const existing = open.get(host.id)
  if (existing && !existing.isDestroyed()) return existing.focus()
  if (!guarded.done) {
    session.fromPartition("pair-phone").webRequest.onBeforeRequest((details, respond) => respond({ cancel: !details.url.startsWith("data:") }))
    guarded.done = true
  }
  const window = new BrowserWindow({
    width: 440,
    height: 600,
    title: `Pair a Phone with ${host.label}`,
    parent,
    show: false,
    webPreferences: { partition: "pair-phone", sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  })
  open.set(host.id, window)
  window.on("closed", () => open.delete(host.id))
  const current = { code: "" }
  const render = async () => {
    const pairing = await readPairing(source)
    current.code = "error" in pairing ? "" : pairing.code
    if (!window.isDestroyed()) await window.webContents.executeJavaScript(`render(${JSON.stringify(pairingView(host.label, pairing))})`)
  }
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-attach-webview", (event) => event.preventDefault())
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault()
    if (url === "es-pair:copy" && current.code) {
      const code = current.code
      clipboard.writeText(code)
      setTimeout(() => { if (clipboard.readText() === code) clipboard.clear() }, CLIPBOARD_MS)
    }
    if (url === "es-pair:rotate") void rotate()
  })
  const rotate = async () => {
    const choice = await dialog.showMessageBox(window, {
      type: "warning",
      buttons: ["Rotate Code", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: `Rotate the pairing code for ${host.label}?`,
      detail: "Every paired phone and browser is signed out and must pair again with the new code.",
    })
    if (choice.response !== 0) return
    const failed = await rotatePairing(source).then(() => false, () => true)
    if (failed) {
      await dialog.showMessageBox(window, { type: "error", message: `Could not rotate the code for ${host.label}.`, detail: "The old code still works." })
      return
    }
    await render()
  }
  window.webContents.once("did-finish-load", () => {
    window.show()
    void render()
  })
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pairingWindowPage)}`)
}
