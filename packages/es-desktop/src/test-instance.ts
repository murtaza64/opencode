/** A second app instance on a disposable profile (ES_DESKTOP_USER_DATA, as tests and probes launch it) shows the same
 * UI with none of the normal profile's pins, drafts or desk history; this says so in the host strip and window title,
 * so it is never mistaken for the normal Editspace. */
export const testInstance = (userData = process.env.ES_DESKTOP_USER_DATA) => userData ? { label: `TEST · ${userData.split("/").filter(Boolean).at(-1) ?? "profile"}`, profile: userData } : undefined
