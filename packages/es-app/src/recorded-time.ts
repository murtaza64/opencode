import type { Message, Part } from "@opencode-ai/sdk/v2"

// One formatter for every recorded message time: full localized date, time and time zone.
const format = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" })

export const recordedTime = (at: number | undefined) => at !== undefined && Number.isFinite(at) ? format.format(at) : undefined

// When a transcript block was recorded: an agent text part's own start, else its message's creation.
// Never render or grouping time.
export const blockTime = (message: Message | undefined, part?: Part) =>
  recordedTime(part?.type === "text" && part.time?.start !== undefined ? part.time.start : message?.time.created)
