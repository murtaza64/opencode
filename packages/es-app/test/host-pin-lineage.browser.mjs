import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage()
const dir = "/Users/mini/fixture/.editspace/lanes/orchestrator/repos/o/r"
const pin = (id) => JSON.stringify([dir, id])
const key = "host:mini:es-app-sidebar-pins"
const rows = ["P", "S"].map((id) => ({ id, title: `Mini ${id}`, directory: dir, time: { created: 1, updated: Date.now() } }))
await page.addInitScript(([storage, value]) => localStorage.setItem(storage, JSON.stringify([value])), [key, pin("P")])
await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.fixture.url },
  { id: "mini", label: "Mac Mini", origin: "http://127.0.0.1:65001", profile: "work" },
] } }))
await page.route("**/hosts/mini/**", (route) => {
  const url = new URL(route.request().url())
  if (url.pathname === "/hosts/mini/oc/experimental/session") return route.fulfill({ json: rows })
  if (url.pathname === "/hosts/mini/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: "/Users/mini/fixture/.editspace" }], default: "fixture" } })
  if (url.pathname === "/hosts/mini/es/api/attention") return route.fulfill({ json: { records: [] } })
  if (url.pathname === "/hosts/mini/es/api/handoffs") {
    expect(url.searchParams.get("es")).toBe("fixture")
    return route.fulfill({ json: { handoffs: [{ lane: "orchestrator", predecessor: "P", successor: "S" }] } })
  }
  if (url.pathname === "/hosts/mini/es/api/state") {
    expect(url.searchParams.get("es")).toBe("fixture")
    return route.fulfill({ json: { editspace: "fixture", threads: [{ lanes: [{ lane: "orchestrator", owner: "S" }] }] } })
  }
  return route.fulfill({ status: 403, body: "not exposed" })
})
try {
  await page.goto(preview.url)
  await expect(page.locator(".sidebar .pinned-section .nav-item[data-host-key='mini:S']")).toBeVisible()
  expect(JSON.parse(await page.evaluate((storage) => localStorage.getItem(storage), key))).toEqual([pin("S")])
  console.log("PASS host pin lineage: Mini P pin follows verified handoff to S")
} finally {
  await browser.close()
  await preview.close()
}
