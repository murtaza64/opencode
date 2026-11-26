import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import type { MessageWithParts } from "../api"
import { sanitizeLensText, type Ask } from "./live-hud"

export const latestReply = (items: MessageWithParts[], session: string, startedAt: number) => items.flatMap(({ info, parts }) => {
  if (info.sessionID !== session || info.role !== "assistant" || info.summary || info.error || !info.time.completed || info.time.created < startedAt) return []
  const text = sanitizeLensText(parts.flatMap(part => part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []).join("")).trim()
  return text ? [{ id: info.id, text, created: info.time.created }] : []
}).sort((a, b) => b.created - a.created || b.id.localeCompare(a.id))[0]

export const porterAsks = (session: string, permissions: PermissionRequest[], questions: QuestionRequest[]): Ask[] => [
  ...permissions.filter(item => item.sessionID === session).map((item): Ask => {
    const detail = item.patterns.join("; ")
    // Do not let a tap authorize a scope that cannot be read in full on the lens.
    const answerable = !!detail && detail.length <= 80 && sanitizeLensText(detail) === detail && item.permission.length <= 34 && sanitizeLensText(item.permission) === item.permission
    return { kind: "permission", id: item.id, title: `Allow ${item.permission}?`, detail, options: ["Allow once", "Reject"], answerable }
  }),
  ...questions.filter(item => item.sessionID === session).flatMap((item): Ask[] => {
    const question = item.questions[0]
    if (!question) return []
    const options = question.options.map(option => option.label)
    return [{ kind: "question", id: item.id, title: question.header, detail: question.question, options,
      answerable: item.questions.length === 1 && !question.multiple && options.length > 0 && options.length <= 3 &&
        options.every(label => !!label && label.length <= 40 && sanitizeLensText(label) === label) }]
  }),
]
