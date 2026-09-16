import { _electron, expect } from "@playwright/test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture, directory } from "../../es-app/test/composer-fixture.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixture = await createFixture()
const profile = await mkdtemp(path.join(tmpdir(), "editspace-draft-restart-"))
const artifacts = path.join(root, "artifacts")
await mkdir(artifacts, { recursive: true })
expect(["4096", "7777", "3181"]).not.toContain(new URL(fixture.url).port)
expect((await (await fetch(`${fixture.url}/config/providers`)).json()).default).toEqual({ fixture: "test" })
const launch = {
  args: [root],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    OPENCODE_URL: fixture.url,
    ES_DASHBOARD_URL: fixture.url,
    OPENCODE_SERVER_PASSWORD: "",
    ES_DESKTOP_USER_DATA: profile,
    ES_DESKTOP_RENDERER: "",
  },
}
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg=="
const image = { id: "fixture-image", mime: "image/png", filename: "legacy.png", url: `data:image/png;base64,${png}` }
const key = (id) => `es-app:composer:1:${JSON.stringify([id, directory])}`
const result = { profile, fixture: fixture.url, pids: [], checkpoints: [] }
const checkpoint = (text) => {
  result.checkpoints.push(text)
  console.info(`PASS ${text}`)
}
let app
let page
let origin
const active = () => page.locator(".float-editor").or(page.locator(".prompt-box:not([inert])"))
const mode = (name) => active().getByRole("radio", { name, exact: true })
const saved = (id) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key(id))
const go = (id) => page.goto(`${origin}/session/${id}?directory=${encodeURIComponent(directory)}`)
const start = async () => {
  app = await _electron.launch(launch)
  result.pids.push(app.process().pid)
  expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(profile)
  page = await app.firstWindow()
  await page.waitForURL("http://127.0.0.1:*/")
  if (origin) expect(new URL(page.url()).origin).toBe(origin)
  origin = new URL(page.url()).origin
}
const restart = async () => {
  await app.close()
  await start()
  expect(result.pids.at(-1)).not.toBe(result.pids.at(-2))
}
const attach = async (filename) => {
  await active()
    .locator("textarea")
    .evaluate(
      (node, { png, filename }) => {
        const data = new DataTransfer()
        data.items.add(
          new File([Uint8Array.from(atob(png), (char) => char.charCodeAt(0))], filename, { type: "image/png" }),
        )
        node.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }))
      },
      { png, filename },
    )
  await expect(active().getByRole("img", { name: filename, exact: true })).toBeVisible()
}
const posts = () => fixture.calls.filter((call) => call.method === "POST")
try {
  await start()
  await page.evaluate(
    ({ key, image }) =>
      sessionStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          mode: "aside",
          asideSeeded: true,
          queueAgent: "plan",
          tracked: [],
          task: { text: "legacy task", images: [image], model: null, selection: [0, 0], revision: 1 },
          aside: {
            text: "legacy aside",
            images: [{ ...image, filename: "legacy-aside.png" }],
            model: { providerID: "fixture", modelID: "test" },
            selection: [0, 0],
            revision: 2,
          },
        }),
      ),
    { key: key("ses_a"), image },
  )
  await go("ses_a")
  await expect(active().locator("textarea")).toHaveValue("legacy aside")
  await expect(active().getByRole("img", { name: "legacy-aside.png" })).toBeVisible()
  expect(await page.evaluate((key) => sessionStorage.getItem(key), key("ses_a"))).toBeNull()
  expect((await saved("ses_a")).task.images).toEqual([image])
  await active().locator("textarea").fill("newer Aside typing")
  await mode("Queue").click()
  await active().locator("textarea").fill("newer task typing")
  await active().getByRole("combobox", { name: "Queue agent" }).selectOption("plan")
  expect(posts()).toHaveLength(0)
  await restart()
  await go("ses_a")
  await expect(active().locator("textarea")).toHaveValue("newer task typing")
  await expect(mode("Queue")).toHaveAttribute("aria-checked", "true")
  await expect(active().getByRole("combobox", { name: "Queue agent" })).toHaveValue("plan")
  await expect(active().getByRole("img", { name: "legacy.png", exact: true })).toHaveAttribute("src", image.url)
  await mode("Aside").click()
  await expect(active().locator("textarea")).toHaveValue("newer Aside typing")
  await expect(active().getByRole("combobox", { name: "Model override" })).toHaveValue("fixture\u0000test")
  expect((await saved("ses_a")).aside.images[0].url).toBe(image.url)
  expect(posts()).toHaveLength(0)
  checkpoint(
    "legacy migration, task/Aside text and images, mode/model/agent survive same-profile process restart without submit",
  )

  await go("ses_b")
  await active().getByRole("button", { name: "Choose message delivery" }).click()
  await active().getByRole("combobox", { name: "Queue agent" }).selectOption("plan")
  await active().locator("textarea").fill("original unknown queue input")
  fixture.loseInput = true
  await active().getByRole("button", { name: "Queue message", exact: true }).click()
  await expect(page.getByRole("region", { name: "Input admission" })).toContainText("Admission unknown")
  const original = posts().at(-1).body
  await active().locator("textarea").fill("newer unsent task")
  await mode("Aside").click()
  await active().locator("textarea").fill("original Aside question")
  await active().getByRole("combobox", { name: "Model override" }).selectOption("fixture\u0000test")
  fixture.holdAside = true
  await active().getByRole("button", { name: "Ask aside", exact: true }).click()
  await expect.poll(() => posts().length).toBe(2)
  const asideID = posts()[1].body.requestID
  await active().locator("textarea").fill("newer unsent Aside")
  await attach("aside-draft.png")
  await mode("Queue").click()
  await attach("task-draft.png")
  await mode("Aside").click()
  await restart()
  await go("ses_b")
  await expect(active().locator("textarea")).toHaveValue("newer unsent Aside")
  await expect(mode("Aside")).toHaveAttribute("aria-checked", "true")
  await expect(active().getByRole("img", { name: "aside-draft.png" })).toBeVisible()
  await expect(page.locator(".aside-result")).toContainText("unknown")
  const restored = await saved("ses_b")
  expect(restored.admission.payload).toEqual(original)
  expect(restored.asideRequest.requestID).toBe(asideID)
  expect(restored.task.text).toBe("newer unsent task")
  expect(restored.task.images[0].url).toBe(image.url)
  expect(restored.aside.images[0].url).toBe(image.url)
  expect(posts()).toHaveLength(2)
  await mode("Queue").click()
  await expect(active().locator("textarea")).toHaveValue("newer unsent task")
  await page.getByRole("button", { name: "Check and retry same input", exact: true }).click()
  await expect.poll(() => posts().length).toBe(3)
  expect(posts()[2].body).toEqual(original)
  expect(fixture.receipts).toHaveLength(1)
  await expect(active().locator("textarea")).toHaveValue("newer unsent task")
  await expect(page.getByRole("region", { name: "Input admission" })).toHaveCount(0)
  checkpoint(
    "unknown queue/Aside identities and newer image drafts survive restart; explicit retry reuses exact original payload once",
  )

  await go("ses_a")
  fixture.setStatus("idle")
  await active().getByRole("button", { name: "Use normal Send", exact: true }).click()
  fixture.loseNormal = true
  await active().getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("region", { name: "Normal Send status" })).toContainText("Outcome unknown")
  expect(posts()).toHaveLength(4)
  await restart()
  await go("ses_a")
  await expect(page.getByRole("region", { name: "Normal Send status" })).toContainText("Outcome unknown")
  await expect(active().locator("textarea")).toHaveValue("newer task typing")
  await expect(active().getByRole("button", { name: "Send", exact: true })).toBeDisabled()
  await expect(active().getByRole("img", { name: "legacy.png", exact: true })).toHaveAttribute("src", image.url)
  expect(posts()).toHaveLength(4)
  await page.screenshot({ path: path.join(artifacts, "drafts-restored.png") })
  checkpoint("unknown normal Send remains visible and blocked after restart; no automatic resubmission")
  result.origin = origin
  result.passed = true
  await writeFile(path.join(artifacts, "draft-restart-results.json"), JSON.stringify(result, null, 2))
  if (process.argv.includes("--preview")) {
    console.info(
      `Isolated native preview running; controller PID ${process.pid}, Electron PID ${app.process().pid}, fixture ${fixture.url}. Close the window to stop.`,
    )
    await new Promise((resolve) => app.on("close", resolve))
  }
} finally {
  await app?.close().catch(() => {})
  await fixture.close()
  await rm(profile, { recursive: true, force: true })
}
