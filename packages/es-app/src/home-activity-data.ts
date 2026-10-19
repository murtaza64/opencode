import type { MailMessage } from "./api"

export type HomeActivityRow = { id: string; level: "major" | "minor"; kind: "mail" | "pr" | "cloud"; text: string; time: number; timeLabel: string; source: string; sourceAt: number; href?: string }

export const prActivity = (value: unknown, observed: number, project: string): HomeActivityRow[] => {
  if (!value || typeof value !== "object") return []
  const pr = value as Record<string, unknown>
  if (typeof pr.url !== "string" || typeof pr.number !== "number" || typeof pr.repo !== "string") return []
  const url = URL.parse(pr.url)
  if (!url || url.protocol !== "https:" || url.hostname !== "github.com") return []
  const merged = pr.state === "merged"
  const event = typeof (merged ? pr.mergedAt : pr.updatedAt) === "string" ? Date.parse(String(merged ? pr.mergedAt : pr.updatedAt)) : NaN
  const time = Number.isFinite(event) ? event : observed
  return [{ id: `pr:${pr.url}`, level: merged ? "major" : "minor", kind: "pr", text: `${pr.repo}#${pr.number} · ${merged ? "merged" : typeof pr.state === "string" ? pr.state : "state unknown"}${typeof pr.title === "string" ? ` · ${pr.title}` : ""}`, time,
    timeLabel: Number.isFinite(event) ? merged ? "merged" : "PR updated" : "cache observed", source: `${project} · cached PR metadata`, sourceAt: observed, href: pr.url }]
}

export const mailActivity = (message: MailMessage, project: string, checked: number): HomeActivityRow => ({
  id: `mail:${project}:${message.id}`, level: "minor", kind: "mail",
  text: `${message.from} → ${message.to} · ${message.kind || "mail"} · ${message.text.replace(/\s+/g, " ").slice(0, 180)}`,
  time: typeof message.ts === "number" ? message.ts < 1e12 ? message.ts * 1000 : message.ts : Date.parse(message.ts), timeLabel: "sent",
  source: `${project} · mail log`, sourceAt: checked,
})
