import { createSignal } from "solid-js"
import { host } from "./host"

// The Work desk's avatar: the canonical image registered for "Porter" in this host's persona registry
// (GET /es/api/personas, clean avatar_url only). Read once per page; none until a registry entry exists.
const [porterAvatar, setPorterAvatar] = createSignal<string>()
const [registry, setRegistry] = createSignal<readonly { name: string; owner_lane: string; avatar_url?: string }[]>([])
let avatarRead = false
const readAvatar = () => {
  if (avatarRead || typeof fetch !== "function") return
  avatarRead = true
  void fetch("/es/api/personas", { credentials: "include" })
    .then(response => response.ok ? response.json() : undefined)
    .then((value: { personas?: { name: string; owner_lane: string; avatar_url: string }[] } | undefined) => {
      setRegistry(value?.personas ?? [])
      setPorterAvatar(value?.personas?.find(entry => entry.name === "Porter" && /^https:\/\//.test(entry.avatar_url))?.avatar_url)
    })
    .catch(() => undefined)
}
/** This host's persona registry (agent names and avatars), read once per page; empty until it answers. */
export const personas = () => { readAvatar(); return registry() }

/** How the desk is named to the person using it. The Work desk is Porter (chosen 2026-11-03); a Personal profile's
 * desk keeps the generic "Front desk" and no avatar. Internal lane, route, session, API and storage ids keep
 * "front-desk"; only user-facing text reads from here, inside reactive scopes so a profile change updates it. */
export const DESK = {
  get name() { return host()?.profile === "personal" ? "Front desk" : "Porter" },
  role: "Front desk",
  /** Accessible name: the name with its role, unless they are the same. */
  get label() { return host()?.profile === "personal" ? "Front desk" : "Porter (Front desk)" },
  /** Porter's registered avatar URL on a Work page; undefined elsewhere or until registered (the glyph shows). */
  get avatar() {
    if (host()?.profile === "personal") return undefined
    readAvatar()
    return porterAvatar()
  },
}
