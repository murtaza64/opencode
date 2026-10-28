import type { BriefItem, DeskItem } from "./desk"

/** Only the ledger answer bound to this brief can identify approved rows. A generic choice says nothing per item. */
export const briefApproval = (rows: BriefItem[], item: DeskItem, job: { id: string; revision: string }) => {
  const record = item.record
  const answer = record?.answer
  const bound = !!answer && item.revision === job.revision && (answer.brief
    ? answer.brief.job === job.id && answer.brief.revision === job.revision
    : answer.revision === record.revision)
  if (!bound || !answer) return { answered: false, values: rows.map(() => ""), verbatim: "" }
  const option = record.options.find(entry => entry.id === answer.choice_id)
  // Do not use inputText here: choice inputs are labels, not the verbatim ledger value.
  const sources = [option?.label ?? "", option?.id ?? "", answer.text, ...answer.input_value === undefined ? [] : Array.isArray(answer.input_value) ? answer.input_value : [answer.input_value]]
  // A range such as "D1-D6" names only its ends literally; matching would mark D1 and D6 approved and leave D2-D5 out.
  // Ranges therefore identify no row, and the verbatim answer is shown once instead.
  const parts = sources.flatMap(source => source.split(/[;\n]/).map(part => part.trim()))
  const values = rows.map(row => parts.find(part => !inRange(part, row.id) && idPattern(row.id).test(part)) ?? "Not individually recorded")
  return { answered: true, values, verbatim: values.includes("Not individually recorded")
    ? [option?.label ?? answer.choice_id ?? "", ...answer.input_value === undefined ? [] : Array.isArray(answer.input_value) ? answer.input_value : [answer.input_value], answer.text].filter(Boolean).join(" · ") : "" }
}

const escape = (id: string) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const idPattern = (id: string) => new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(id)}(?=$|[^\\p{L}\\p{N}_])`, "u")

const inRange = (part: string, id: string) =>
  new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(id)}\\s*[-–—]\\s*[\\p{L}_]*\\p{N}`, "u").test(part) ||
  new RegExp(`[\\p{L}_]*\\p{N}+\\s*[-–—]\\s*${escape(id)}(?=$|[^\\p{L}\\p{N}_])`, "u").test(part)
