/* Posts one OS notification for `watchNotifications`. Kept out of main.ts so window show/focus
 * paths there stay auditable; a notification never shows or focuses a window by itself. */
import { Notification } from "electron"
import type { Notice } from "./notify"

const BODY: Record<Notice["kind"], string> = {
  decision: "Decision needed",
  permission: "Permission needed",
  question: "Question waiting",
  stalled: "Answered over 4 h ago, still unresolved",
  "delivery-blocked": "Answer not delivered",
}

export const notificationsSupported = () => Notification.isSupported()

export const postNotice = (notice: Notice, onClick: () => void) => {
  const item = new Notification({ title: notice.title, body: BODY[notice.kind] })
  item.on("click", onClick)
  item.show()
  return { close: () => item.close() }
}
