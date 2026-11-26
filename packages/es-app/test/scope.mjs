// The Agents tab's Filter popover (Laptop2677): project scope, hosts, show and sort live there. selectScope opens it
// and chooses a project, or "__all__"; from another tab it switches to Agents, chooses, and returns to that tab.
const panel = page => page.locator("nav.sidebar .sidebar-filter-panel")
export const openFilter = async page => {
  const menu = page.locator("nav.sidebar .sidebar-filter").first()
  if (!(await menu.evaluate(element => element.open))) await menu.locator("summary").click()
  return panel(page)
}
export const closeFilter = async page => {
  const menu = page.locator("nav.sidebar .sidebar-filter").first()
  if (await menu.evaluate(element => element.open)) await panel(page).getByRole("button", { name: "Done" }).click()
}
/** Check or click one option of the popover by its fieldset legend and label text. */
export const chooseFilter = async (page, legend, label) => {
  const options = await openFilter(page)
  await options.locator("fieldset", { has: page.locator("legend", { hasText: legend }) }).locator("label", { hasText: label }).click()
  await closeFilter(page)
}
export const selectScope = async (page, value) => {
  const tabs = page.locator("nav.sidebar [role=tablist] [role=tab]")
  const previous = await tabs.count() ? await page.locator("nav.sidebar [role=tab][aria-selected=true]").getAttribute("id") : null
  if (previous && previous !== "nav-tab-agents") await page.locator("#nav-tab-agents").click()
  await chooseFilter(page, "Project", value === "__all__" ? /^All projects$/ : new RegExp(`^${value}$`))
  if (previous && previous !== "nav-tab-agents") await page.locator(`#${previous}`).click()
}
