// Historical four-mode UI coverage. Chosen direct-action UI runs composer-direct.browser.mjs.
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import { createServer } from "vite"
import { createFixture, directory } from "./composer-fixture.mjs"

// Reuse the workspace's existing browser harness dependency, never a global install.
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const fixture = await createFixture()
process.env.OPENCODE_URL = fixture.url
process.env.ES_DASHBOARD_URL = fixture.url
const vite = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
})
await vite.listen()
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const artifacts = fileURLToPath(new URL("../artifacts/composer/", import.meta.url))
await mkdir(artifacts, { recursive: true })
const errors = []
const mutations = () => fixture.calls.filter((call) => call.method !== "GET")
const inputPosts = () => mutations().filter((call) => call.path.endsWith("/input"))
const go = (page, id = "ses_a") => page.goto(`${origin}/session/${id}?directory=${encodeURIComponent(directory)}`)
const active = (page) => page.locator(".float-editor").or(page.locator(".prompt-box:not([inert])"))
const editor = (page) => active(page).locator("textarea")
const mode = (page, name) => active(page).getByRole("radio", { name, exact: true })
const noOverflow = async (page) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const box = await active(page).boundingBox()
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 1)
}
const reachable = async (locator) => {
  await locator.scrollIntoViewIfNeeded()
  expect(
    await locator.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return rect.top >= 0 && rect.bottom <= innerHeight && (hit === el || el.contains(hit))
    }),
  ).toBe(true)
}
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await context.route("**/*", (route) => {
  const url = new URL(route.request().url())
  if (url.origin === origin || url.protocol === "data:" || url.protocol === "blob:") return route.continue()
  errors.push(`External request: ${url.origin}`)
  return route.abort()
})
const page = await context.newPage()
page.on("pageerror", (error) => errors.push(error.message))
try {
  await go(page)
  await expect(mode(page, "Queue")).toHaveAttribute("aria-checked", "true")
  await expect(active(page).getByRole("button", { name: "Queue message", exact: true })).toBeDisabled()
  await editor(page).fill("task draft")
  await expect(active(page).getByRole("button", { name: "Queue message", exact: true })).toBeEnabled()
  const queueAgent = () => active(page).getByLabel("Queue agent", { exact: true })
  await expect(queueAgent()).toBeEnabled()
  expect(await queueAgent().locator("option").allTextContents()).toEqual(["Current: build", "build", "plan"])
  await queueAgent().selectOption("plan")
  const textarea = await editor(page).boundingBox()
  const footer = await active(page).locator(".composer-controls").boundingBox()
  expect(footer.y).toBeGreaterThanOrEqual(textarea.y + textarea.height)
  expect((await queueAgent().boundingBox()).y).toBe((await mode(page, "Queue").boundingBox()).y)
  await active(page).screenshot({ path: `${artifacts}/footer-queue-desktop.png` })
  const top = (await editor(page).boundingBox()).y
  expect((await active(page).locator(".composer-controls").boundingBox()).height).toBeLessThanOrEqual(84)
  await expect(active(page).getByRole("button", { name: "Refresh availability", exact: true })).toHaveCount(0)
  await mode(page, "Aside").click()
  expect((await editor(page).boundingBox()).y).toBe(top)
  await active(page).screenshot({ path: `${artifacts}/compact-desktop.png` })
  await expect(editor(page)).toHaveValue("task draft")
  await expect(active(page).locator(".composer-agent")).toHaveText("build")
  await expect(queueAgent()).toHaveCount(0)
  await editor(page).fill("aside question")
  await mode(page, "Queue").click()
  expect((await editor(page).boundingBox()).y).toBe(top)
  await expect(editor(page)).toHaveValue("task draft")
  await expect(queueAgent()).toHaveValue("plan")
  expect(mutations()).toHaveLength(0)

  await editor(page).focus()
  await editor(page).evaluate((el) => el.setSelectionRange(2, 5))
  await editor(page).press("Alt+m")
  await expect(mode(page, "Steer")).toHaveAttribute("aria-checked", "true")
  await expect(editor(page)).toBeFocused()
  await expect(editor(page)).toHaveClass(/vim-insert/)
  await editor(page).press("Alt+m")
  await expect(mode(page, "Aside")).toHaveAttribute("aria-checked", "true")
  await expect(editor(page)).toHaveValue("aside question")
  await editor(page).press("Alt+m")
  await expect(mode(page, "Queue")).toHaveAttribute("aria-checked", "true")
  await expect(editor(page)).toHaveValue("task draft")
  expect(await editor(page).evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([2, 5])
  await editor(page).dispatchEvent("keydown", { key: "\u00b5", code: "KeyM", altKey: true, isComposing: true })
  await expect(mode(page, "Queue")).toHaveAttribute("aria-checked", "true")
  await editor(page).dispatchEvent("keydown", { key: "\u00b5", code: "KeyM", altKey: true })
  await expect(mode(page, "Steer")).toHaveAttribute("aria-checked", "true")
  await editor(page).dispatchEvent("keydown", { key: "\u00b5", code: "KeyM", altKey: true, repeat: true })
  await expect(mode(page, "Steer")).toHaveAttribute("aria-checked", "true")
  await mode(page, "Aside").focus()
  await page.keyboard.press("Alt+m")
  await expect(mode(page, "Aside")).toBeFocused()
  await mode(page, "Queue").click()
  expect(mutations()).toHaveLength(0)

  await mode(page, "Queue").focus()
  await page.keyboard.press("ArrowRight")
  await expect(mode(page, "Steer")).toBeFocused()
  await page.keyboard.press("Space")
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  expect(mutations()).toHaveLength(0)
  await page.keyboard.press("Tab")
  expect(page.url()).toContain("ses_a")
  fixture.setStatus("idle")
  await expect(page.getByRole("button", { name: "Use normal Send", exact: true })).toBeVisible()
  await expect(mode(page, "Steer")).toHaveAttribute("aria-checked", "true")

  fixture.holdInput = true
  await editor(page).press("Control+Enter")
  await expect.poll(() => inputPosts().length).toBe(1)
  expect(inputPosts()[0].body.agent).toBeUndefined()
  await editor(page).press("Control+Enter")
  await editor(page).fill("newer typing")
  fixture.holdInput = false
  fixture.inputReplies.shift()()
  await expect(page.locator(".input-receipts")).toContainText("task draft")
  await expect(editor(page)).toHaveValue("newer typing")
  expect(inputPosts()).toHaveLength(1)
  const cancelSteer = page.locator(".input-receipts").getByRole("button", { name: /Cancel steer/ })
  await cancelSteer.focus()
  fixture.emit("session.input.updated", { sessionID: "ses_a" })
  await expect
    .poll(() => fixture.calls.filter((call) => call.path.endsWith(`/input/${inputPosts()[0].body.requestID}`)).length)
    .toBeGreaterThan(0)
  await expect(cancelSteer).toBeFocused()
  await page
    .locator(".input-receipts")
    .getByRole("button", { name: /Cancel steer/ })
    .click()
  await expect(page.locator(".input-receipts")).toHaveCount(0)

  await mode(page, "Aside").click()
  await expect(editor(page)).toHaveValue("aside question")
  await active(page).getByRole("button", { name: "Ask aside", exact: true }).click()
  await expect(page.getByRole("region", { name: "Aside result" })).toContainText("ASIDE ONLY")
  await expect(page.locator(".transcript")).not.toContainText("ASIDE ONLY")
  await expect(page.locator(".aside-snapshot")).toContainText("msg_boundary")
  await expect(editor(page)).toHaveValue("aside question")
  await page.screenshot({ path: `${artifacts}/desktop.png`, fullPage: true })
  await page.getByRole("button", { name: "Close aside", exact: true }).click()
  fixture.holdAside = true
  await active(page).getByRole("button", { name: "Ask aside", exact: true }).click()
  await expect(page.getByRole("button", { name: "Cancel aside", exact: true })).toBeVisible()
  fixture.setStatus("busy")
  await editor(page).focus()
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  expect(mutations().some((call) => call.path.endsWith("/abort"))).toBe(false)
  fixture.failCancel = true
  await page.getByRole("button", { name: "Cancel aside", exact: true }).click()
  await expect(page.locator(".aside-result")).toContainText("cancellation not confirmed")
  fixture.failCancel = false
  await page.getByRole("button", { name: "Cancel aside", exact: true }).click()
  await expect(page.locator(".aside-result")).toContainText("cancelled")
  fixture.holdAside = false
  fixture.asideReplies.shift()()
  await page.getByRole("button", { name: "Close aside", exact: true }).click()

  fixture.holdAside = true
  await active(page).getByRole("button", { name: "Ask aside", exact: true }).click()
  fixture.noActiveAside = true
  await page.getByRole("button", { name: "Cancel aside", exact: true }).click()
  await expect(page.locator(".aside-result")).toContainText("No active Aside remains")
  await page.getByRole("button", { name: "Close aside", exact: true }).click()
  fixture.noActiveAside = false
  fixture.holdAside = false
  fixture.asideReplies.shift()()

  await mode(page, "Queue").click()
  fixture.loseInput = true
  await active(page).getByRole("button", { name: "Queue message", exact: true }).click()
  await expect(page.locator(".input-admission")).toContainText("Admission unknown")
  await expect(page.locator(".input-receipts")).toHaveCount(0)
  const unknown = inputPosts().at(-1).body
  expect(unknown.agent).toBe("plan")
  await queueAgent().selectOption("build")
  await editor(page).fill("draft after unknown")
  await page.reload()
  await expect(editor(page)).toHaveValue("draft after unknown")
  await expect(queueAgent()).toHaveValue("build")
  await page.getByRole("button", { name: "Check and retry same input", exact: true }).click()
  await expect(page.locator(".input-admission")).toHaveCount(0)
  expect(inputPosts().at(-1).body).toEqual(unknown)
  await expect(editor(page)).toHaveValue("draft after unknown")
  expect(fixture.calls.some((call) => call.path.endsWith(`/input/${unknown.requestID}`) && call.method === "GET")).toBe(
    true,
  )

  fixture.promoteOnCancel = true
  await page
    .locator(".input-receipts")
    .getByRole("button", { name: /Cancel queue/ })
    .click()
  await expect(page.locator(".input-receipts")).toHaveCount(0)
  await expect(active(page)).toContainText("cancellation was not applied")
  fixture.promoteOnCancel = false

  await editor(page).fill("accepted without acknowledgement")
  fixture.acceptedAckLost = true
  const postsBefore = inputPosts().length
  await active(page).getByRole("button", { name: "Queue message", exact: true }).click()
  await expect(page.locator(".input-admission")).toContainText("Admission unknown")
  await page.getByRole("button", { name: "Check admission", exact: true }).click()
  await expect(page.locator(".input-admission")).toHaveCount(0)
  expect(inputPosts()).toHaveLength(postsBefore + 1)
  await expect(editor(page)).toHaveValue("")

  fixture.setStatus("idle")
  await expect(active(page).locator(".composer-normal-mode")).toHaveText("Normal Send")
  await expect(active(page).getByRole("radio")).toHaveCount(0)
  await active(page).getByLabel("Model override").selectOption("fixture\u0000test")
  await editor(page).evaluate((el) => {
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array([1, 2, 3])], "draft.png", { type: "image/png" }))
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }))
  })
  await expect(active(page).getByRole("button", { name: "Remove draft.png", exact: true })).toBeVisible()
  fixture.setStatus("busy")
  await expect(active(page)).toContainText("Normal Send is unavailable")
  await active(page).getByRole("button", { name: "Choose message delivery", exact: true }).click()
  await expect(mode(page, "Queue")).toHaveAttribute("aria-checked", "true")
  await expect(active(page)).toContainText("text-only")
  await mode(page, "Aside").click()
  await expect(active(page).getByRole("button", { name: "Remove draft.png", exact: true })).toHaveCount(0)
  await mode(page, "Queue").click()
  await expect(active(page).getByRole("button", { name: "Remove draft.png", exact: true })).toBeVisible()
  await active(page).getByRole("button", { name: "Remove draft.png", exact: true }).click()
  await expect(active(page)).toContainText("Clear the model override")
  await active(page).getByRole("button", { name: "Use session model", exact: true }).click()
  await editor(page).fill("x".repeat(399))
  await editor(page).pressSequentially("yz")
  await expect(page.locator(".float-editor")).toBeVisible()
  await editor(page).pressSequentially("!")
  await expect(editor(page)).toHaveValue("x".repeat(399) + "yz!")
  await editor(page).fill("long draft line\n".repeat(12))
  await expect(page.locator(".float-editor")).toBeVisible()
  await expect(mode(page, "Queue")).toHaveAttribute("aria-checked", "true")
  await mode(page, "Aside").click()
  await expect(editor(page)).toHaveValue("aside question")
  await editor(page).press("Escape")
  await editor(page).press("Escape")
  await editor(page).press("Escape")
  expect(mutations().some((call) => call.path.endsWith("/abort"))).toBe(false)
  await editor(page).press("Alt+m")
  await expect(mode(page, "Queue")).toHaveAttribute("aria-checked", "true")
  await expect(editor(page)).toBeFocused()
  await expect(editor(page)).toHaveClass(/vim-normal/)
  await editor(page).press("Alt+m")
  await expect(mode(page, "Steer")).toHaveAttribute("aria-checked", "true")
  await editor(page).press("Alt+m")
  await expect(mode(page, "Aside")).toHaveAttribute("aria-checked", "true")
  await expect(editor(page)).toHaveValue("aside question")
  await mode(page, "Steer").click()
  await expect(editor(page)).toHaveValue("long draft line\n".repeat(12))
  const floatingTextarea = await editor(page).boundingBox()
  expect((await active(page).locator(".composer-controls").boundingBox()).y).toBeGreaterThanOrEqual(
    floatingTextarea.y + floatingTextarea.height,
  )
  await noOverflow(page)
  await reachable(editor(page))
  await reachable(active(page).getByRole("button", { name: "Steer task", exact: true }))
  await page.screenshot({ path: `${artifacts}/floating-desktop.png`, fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await noOverflow(page)
  await reachable(editor(page))
  await page.screenshot({ path: `${artifacts}/floating-mobile.png`, fullPage: true })
  await page
    .getByRole("button", { name: /collapse/ })
    .filter({ hasText: "collapse" })
    .click()
  await noOverflow(page)
  await reachable(editor(page))
  await reachable(active(page).getByRole("button", { name: "Steer task", exact: true }))
  await page.screenshot({ path: `${artifacts}/mobile-sidebars-open.png`, fullPage: true })
  fixture.receipts.push(
    ...Array.from({ length: 30 }, (_, index) => ({
      requestID: `many-${index}`,
      sessionID: "ses_a",
      delivery: "queue",
      text: `Long pending input ${index}: ` + "detail ".repeat(100),
      agent: "build",
      state: "pending",
      admittedSeq: 100 + index,
      timeCreated: 1,
    })),
  )
  fixture.emit("session.input.updated", { sessionID: "ses_a" })
  const lastPending = page.locator('[data-request-id="many-29"] button')
  await expect(lastPending).toBeVisible()
  await reachable(lastPending)
  await lastPending.click()
  await expect(page.locator('[data-request-id="many-29"]')).toHaveCount(0)
  await reachable(editor(page))
  await noOverflow(page)
  await page.keyboard.press("Control+h")
  await page.keyboard.press("Control+l")
  await noOverflow(page)
  await page.screenshot({ path: `${artifacts}/mobile-sidebars-closed.png`, fullPage: true })
  await page.evaluate(() => {
    document.documentElement.dir = "rtl"
  })
  await editor(page).fill("\u0645\u0631\u062d\u0628\u0627 README.md /tmp/example 123")
  await noOverflow(page)
  await mode(page, "Steer").focus()
  await page.keyboard.press("ArrowRight")
  await expect(mode(page, "Queue")).toBeFocused()
  await page.evaluate(() => {
    document.documentElement.dir = "ltr"
  })

  await editor(page).fill("preserved on reconnect")
  fixture.failSnapshot = true
  fixture.disconnect()
  await expect(page.locator(".topbar")).toContainText("disconnected")
  await expect(mode(page, "Queue")).toHaveAttribute("aria-checked", "true")
  await expect(active(page).getByRole("button", { name: "Queue message", exact: true })).toBeDisabled()
  fixture.failSnapshot = false
  await page.getByRole("button", { name: "reconnect", exact: true }).click()
  await expect(active(page).getByRole("button", { name: "Queue message", exact: true })).toBeEnabled({ timeout: 10000 })
  await expect(editor(page)).toHaveValue("preserved on reconnect")

  // Router navigation, not page.goto: the old controller must outlive its view.
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.keyboard.press("Control+h")
  fixture.holdInput = true
  await active(page).getByRole("button", { name: "Queue message", exact: true }).click()
  await expect.poll(() => fixture.inputReplies.length).toBe(1)
  await page.locator('.sidebar a[href*="/session/ses_b"]').first().click()
  await editor(page).fill("other session draft")
  await editor(page).press("Alt+m")
  await expect(mode(page, "Aside")).toHaveAttribute("aria-checked", "true")
  await expect(editor(page)).toHaveValue("other session draft")
  await active(page).getByRole("button", { name: "Use normal Send", exact: true }).click()
  fixture.holdInput = false
  fixture.inputReplies.shift()()
  await expect(editor(page)).toHaveValue("other session draft")
  await active(page).getByLabel("Model override").selectOption("fixture\u0000test")
  await active(page).getByRole("button", { name: "Send", exact: true }).click()
  await expect(editor(page)).toHaveValue("")
  expect(mutations().find((call) => call.path === "/session/ses_b/prompt_async").body.model).toEqual({
    providerID: "fixture",
    modelID: "test",
  })
  await page.locator('.sidebar a[href*="/session/ses_a"]').first().click()
  await expect(editor(page)).toHaveValue("")
  fixture.capabilities = false
  fixture.failAgents = true
  await page.reload()
  await expect(active(page)).toContainText("Agent list unavailable")
  await expect(queueAgent()).toHaveValue("build")
  await expect(queueAgent()).toBeDisabled()
  fixture.failAgents = false
  await active(page).getByRole("button", { name: "Retry agents", exact: true }).click()
  await expect(queueAgent()).toBeEnabled()
  await expect(active(page)).toContainText("does not support")
  await active(page).getByRole("button", { name: "Refresh availability", exact: true }).click()
  await expect(active(page)).toContainText("does not support")
  await expect(active(page).getByRole("button", { name: "Queue message", exact: true })).toBeDisabled()
  expect(mutations().some((call) => /permission|question|abort|ses_a\/prompt_async/.test(call.path))).toBe(false)
  expect(
    inputPosts().every(
      (call) =>
        call.directory === directory && !call.body.model && (call.body.delivery === "queue" || !call.body.agent),
    ),
  ).toBe(true)
  expect(
    mutations()
      .filter((call) => call.path.endsWith("/aside"))
      .every((call) => !call.body.agent),
  ).toBe(true)
  expect(fixture.calls.filter((call) => call.path === "/agent").every((call) => call.directory === directory)).toBe(
    true,
  )
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
  console.log(
    "PASS composer browser: modes, drafts/media/models, floating, keyboard, ack/retry, cancellation, reconnect, capabilities, mobile/RTL; screenshots:",
    artifacts,
  )
} finally {
  await fixture.close()
  await browser.close()
  await vite.close()
}
