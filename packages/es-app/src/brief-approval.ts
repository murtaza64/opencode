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
  const values = rows.map(row => sources.flatMap(source => source.split(/[;\n]/).map(part => part.trim())).find(source => new RegExp(`(^|[^\\p{L}\\p{N}_])${row.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}_])`, "u").test(source)) ?? "Not individually recorded")
  return { answered: true, values, verbatim: values.includes("Not individually recorded")
    ? [option?.label ?? answer.choice_id ?? "", ...answer.input_value === undefined ? [] : Array.isArray(answer.input_value) ? answer.input_value : [answer.input_value], answer.text].filter(Boolean).join(" · ") : "" }
}
