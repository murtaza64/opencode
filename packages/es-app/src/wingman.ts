export const wingmanStatus = (status?: string) => {
  switch (status) {
    case "processing": return { label: "working", chip: "busy" }
    case "waiting": return { label: "waiting", chip: "parked" }
    case "ended": return { label: "ended", chip: "plain" }
    case "failed": return { label: "failed", chip: "failing" }
    case "timed_out": return { label: "timed out", chip: "failing" }
    default: return { label: status || "unknown", chip: "plain" }
  }
}

export const wingmanPrs = (value?: string) =>
  (value ?? "").split(/\s+/).filter((url) => URL.parse(url)?.protocol === "https:")
