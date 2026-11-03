// Comment bridge privacy (M1.1): declared anchors, host-narrowed picks, comments off, and private subtrees, form
// fields and editable regions that never become anchors or hashed text. Drives the real bridge (surface-bridge.ts)
// in an opaque-origin sandboxed frame from a bare parent page, as the Surface reader does. Run from packages/es-app.
import { createRequire } from "node:module"
import { injectBridge } from "../surface-bridge.ts"
import { createAnchorKit } from "../../surface-bridge/src/index.js"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })

const STYLE = "<style>body{font:15px sans-serif;margin:16px} section{padding:24px;margin:0 0 12px;border:1px solid #888}</style>"
const OPEN_PAGE = `<!doctype html><html><head>${STYLE}</head><body>
<section id="notes"><h2>Notes</h2><p id="public">Public line</p>
  <div data-es-private><p id="secret">Local note: SECRET-123</p><p data-anchor="inside-private">Readback</p></div>
  <textarea id="draft">draft one</textarea><div contenteditable id="editable">editable one</div><input id="field" value="field one">
</section>
<section data-anchor="sec/public"><p id="declared-child">Declared section text</p></section>
</body></html>`
const DECLARED_PAGE = `<!doctype html><html><head><meta name="es-comments-anchors" content="declared">${STYLE}</head><body>
<section data-anchor="sec/a"><h2>Section A</h2><p id="a-copy">Copy inside A</p></section>
<p id="loose">Loose paragraph with no anchor</p>
<div data-es-private><section data-anchor="sec/private"><p id="private-copy">Private note</p></section></div>
</body></html>`
const OFF_PAGE = `<!doctype html><html><head><meta name="es-comments-anchors" content="off">${STYLE}</head><body><section data-anchor="sec/x"><p id="x">X</p></section></body></html>`

const open = async (html) => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.setContent(`<iframe sandbox="allow-scripts" style="width:860px;height:860px;border:0"></iframe>
<script>window.msgs = []; addEventListener("message", (event) => { if (event.data && event.data.ns === "es-comments") msgs.push(event.data) })</script>`)
  await page.locator("iframe").evaluate((frame, srcdoc) => { frame.srcdoc = srcdoc }, injectBridge(html))
  const messages = (type) => page.evaluate((type) => window.msgs.filter((message) => message.type === type), type)
  const send = (message) => page.locator("iframe").evaluate((frame, message) => frame.contentWindow.postMessage({ ns: "es-comments", ...message }, "*"), message)
  await expect.poll(() => messages("ready")).toHaveLength(1)
  // Pick mode is on once the frame shows its crosshair (postMessage is asynchronous).
  const pick = async (message = {}) => {
    await send({ type: "pick", on: true, ...message })
    await expect(page.frameLocator("iframe").locator("html")).toHaveCSS("cursor", "crosshair")
  }
  // States for these anchors, from the first report that carries this track call's keys (reports for earlier
  // track calls may still be in flight).
  let calls = 0
  const track = async (anchors, policy) => {
    const call = `t${++calls}`
    await send({ type: "track", anchors: anchors.map((anchor, index) => ({ key: `${call}:${index}`, anchor })), ...(policy ? { policy } : {}) })
    const report = async () => (await messages("rects")).find((message) => message.items[0]?.key === `${call}:0`)
    await expect.poll(report).toBeTruthy()
    return (await report()).items.map((item) => item.state)
  }
  return { page, errors, messages, send, track, pick, frame: page.frameLocator("iframe") }
}

try {
  {
    // Open page: a click inside a private subtree is ignored; the next click outside it picks.
    const { page, errors, messages, send, track, pick, frame } = await open(OPEN_PAGE)
    expect((await messages("ready"))[0].policy).toBe("open")
    await pick()
    await frame.locator("#secret").click()
    await frame.locator("#public").click()
    await expect.poll(async () => (await messages("picked")).length).toBe(1)
    const picked = await messages("picked")
    expect(picked).toHaveLength(1)
    expect(picked[0].anchor.id).toBe("public")
    expect(JSON.stringify(picked)).not.toContain("SECRET")

    // Anchors that point into a private subtree are never tracked, by id, data-anchor or selector.
    expect(await track([{ id: "secret" }, { id: "inside-private" }, { selector: "#notes > div > p" }, { id: "public" }])).toEqual(["missing", "missing", "missing", "shown"])

    // The section's text hash ignores private text, form fields and editable drafts; visible text still counts.
    await pick()
    await frame.locator("#notes").click({ position: { x: 4, y: 4 } })
    await expect.poll(async () => (await messages("picked")).length).toBe(2)
    const section = (await messages("picked"))[1].anchor
    expect(section.id).toBe("notes")
    await frame.locator("#draft").fill("a different private draft")
    await frame.locator("#field").fill("a different field value")
    await frame.locator("#editable").evaluate((el) => { el.textContent = "edited draft" })
    await frame.locator("#secret").evaluate((el) => { el.textContent = "Local note: SECRET-456" })
    expect(await track([section])).toEqual(["shown"])
    await frame.locator("#public").evaluate((el) => { el.textContent = "Public line, revised" })
    expect(await track([section])).toEqual(["changed"])

    // The host narrows one pick to declared anchors: a declared section's id and rect, nothing else.
    await pick({ policy: "declared" })
    await frame.locator("#declared-child").click()
    await expect.poll(async () => (await messages("picked")).length).toBe(3)
    expect(Object.keys((await messages("picked"))[2].anchor).sort()).toEqual(["id", "rect"])
    expect((await messages("picked"))[2].anchor.id).toBe("sec/public")
    expect(errors).toEqual([])
    await page.close()
  }
  {
    // Declared page: only [data-anchor] picks, as { id, rect }; loose and private content never picks.
    const { page, errors, messages, send, track, pick, frame } = await open(DECLARED_PAGE)
    expect((await messages("ready"))[0].policy).toBe("declared")
    await pick()
    await frame.locator("#loose").click()
    await frame.locator("#private-copy").click()
    await frame.locator("#a-copy").click()
    await expect.poll(async () => (await messages("picked")).length).toBe(1)
    const picked = await messages("picked")
    expect(picked).toHaveLength(1)
    expect(Object.keys(picked[0].anchor).sort()).toEqual(["id", "rect"])
    expect(picked[0].anchor.id).toBe("sec/a")

    // The host cannot loosen the page: an "open" pick still yields a declared anchor.
    await pick({ policy: "open" })
    await frame.locator("#a-copy").click()
    await expect.poll(async () => (await messages("picked")).length).toBe(2)
    expect(Object.keys((await messages("picked"))[1].anchor).sort()).toEqual(["id", "rect"])

    // No element-id, selector or private fallback, and no text comparison for declared anchors.
    expect(await track([{ id: "loose" }, { selector: "body > p" }, { id: "sec/private" }, { id: "sec/a", hash: "deadbeef" }])).toEqual(["missing", "missing", "missing", "shown"])
    expect(errors).toEqual([])
    await page.close()
  }
  {
    // Comments off: ready says so, a pick ends at once, nothing is tracked.
    const { page, errors, messages, send, track, frame } = await open(OFF_PAGE)
    expect((await messages("ready"))[0].policy).toBe("off")
    await send({ type: "pick", on: true })
    await expect.poll(async () => (await messages("pick-end")).length).toBe(1)
    await frame.locator("#x").click()
    expect(await messages("picked")).toEqual([])
    expect(await track([{ id: "sec/x" }])).toEqual(["missing"])
    expect(errors).toEqual([])
    await page.close()
  }
  {
    // The kit's visible text, for hosts that keep their own anchors: private, field and editable content never appears.
    const page = await browser.newPage()
    await page.setContent(`<section id="s">
<h2>Notes</h2>
<p>Public line</p>
<div data-es-private><p>SECRET-123</p></div>
<textarea>draft text</textarea>
<input value="field text">
<div contenteditable>editable text</div>
<select><option>choice text</option></select>
</section>`)
    const text = await page.evaluate((source) => new Function(`return (${source})`)()(window).textOf(document.getElementById("s")), createAnchorKit.toString())
    expect(text).toBe("Notes Public line")
    // Over the 4000-char default cap: the default stops at 4000; max Infinity or 0 returns all of it, still filtered.
    await page.setContent(`<p id="long">${"a".repeat(5000)}<span data-es-private>SECRET</span>${"b".repeat(10)}</p>`)
    const lengths = await page.evaluate((source) => {
      const kit = new Function(`return (${source})`)()(window)
      const el = document.getElementById("long")
      return { capped: kit.textOf(el), full: kit.textOf(el, { max: Infinity }), zero: kit.textOf(el, { max: 0 }), small: kit.textOf(el, { max: 3 }) }
    }, createAnchorKit.toString())
    expect(lengths.capped).toBe("a".repeat(4000))
    expect(lengths.full).toBe("a".repeat(5000) + "b".repeat(10))
    expect(lengths.zero).toBe(lengths.full)
    expect(lengths.small).toBe("aaa")
    await page.close()
  }
  console.log("surface-bridge-privacy: PASS")
} finally {
  await browser.close()
}
