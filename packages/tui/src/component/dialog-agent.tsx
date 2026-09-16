import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

export function DialogAgent(props: { selection?: { current?: string; select: (agent: string) => void } } = {}) {
  const local = useLocal()
  const dialog = useDialog()

  const options = createMemo(() =>
    local.agent.list().map((item) => {
      return {
        value: item.name,
        title: item.name,
        description: item.native ? "native" : item.description,
      }
    }),
  )

  return (
    <DialogSelect
      title={props.selection ? "Queue agent" : "Select agent"}
      current={props.selection ? props.selection.current : local.agent.current()?.name}
      options={options()}
      onSelect={(option) => {
        if (props.selection) props.selection.select(option.value)
        if (!props.selection) local.agent.set(option.value)
        dialog.clear()
      }}
    />
  )
}
