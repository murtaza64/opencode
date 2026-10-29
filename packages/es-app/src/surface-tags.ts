/* The author's Surface tags (NAV-19, dotfiles 53b1fe26): form and accents, validated for rendering. */
const FORMS = ["document", "dashboard", "prototype"] as const
const ACCENTS = ["interactive", "live"] as const
export type Form = (typeof FORMS)[number]
export type Accent = (typeof ACCENTS)[number]

/** The author's tags as this renderer understands them; unknown values are dropped. */
export const surfaceTags = (surface: object) => {
  const raw = surface as { form?: unknown; accents?: unknown }
  const form = FORMS.find((value) => value === raw.form)
  const accents = ACCENTS.filter((value) => Array.isArray(raw.accents) && raw.accents.includes(value))
  return { form, accents }
}

const FORM_LABEL: Record<Form, string> = { document: "document", dashboard: "dashboard", prototype: "prototype" }

/** "document, interactive" for the row's accessible name and tooltip; "surface" when untagged. */
export const surfaceKindLabel = (surface: object) => {
  const tags = surfaceTags(surface)
  return [tags.form ? FORM_LABEL[tags.form] : "surface", ...tags.accents].join(", ")
}

