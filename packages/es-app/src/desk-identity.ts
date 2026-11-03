import { host } from "./host"

/** How the desk is named to the person using it. The Work desk is Porter (chosen 2026-11-03); a Personal profile's
 * desk keeps the generic "Front desk". Internal lane, route, session, API and storage ids keep "front-desk"; only
 * user-facing text reads from here, inside reactive scopes so a profile change updates it. `avatar` stays empty until
 * the canonical Porter image is delivered, and the existing desk glyph is shown meanwhile. */
export const DESK = {
  get name() { return host()?.profile === "personal" ? "Front desk" : "Porter" },
  role: "Front desk",
  /** Accessible name: the name with its role, unless they are the same. */
  get label() { return host()?.profile === "personal" ? "Front desk" : "Porter (Front desk)" },
  avatar: undefined as string | undefined,
}
