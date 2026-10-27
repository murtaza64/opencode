import { Diagnostics } from "@opencode-ai/core/diagnostics"
import { ServerAuth } from "@/server/auth"
import { cmd } from "../cmd"

const url = {
  type: "string",
  default: process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096",
  describe: "daemon base URL",
} as const

const request = async (base: string, path: string, init: RequestInit = {}) => {
  const response = await fetch(new URL(path, base), {
    ...init,
    headers: {
      "content-type": "application/json",
      [Diagnostics.TOKEN_HEADER]: await Diagnostics.localToken(),
      ...ServerAuth.headers(),
    },
  })
  const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
  if (!response.ok) {
    console.error(`diagnostics request failed (${response.status}): ${body.error ?? JSON.stringify(body)}`)
    process.exitCode = 1
    return undefined
  }
  return body
}

export const DiagnosticsCommand = cmd({
  command: "diagnostics",
  describe: "print the running daemon's performance diagnostics (event loop, requests, SQL, memory)",
  builder: (yargs) => yargs.option("url", url),
  async handler(args) {
    const body = await request(args.url, "/global/diagnostics")
    if (body) console.log(JSON.stringify(body, null, 2))
  },
})

export const ProfileCommand = cmd({
  command: "profile",
  describe: "capture a bounded CPU profile of the running daemon",
  builder: (yargs) =>
    yargs
      .option("url", url)
      .option("seconds", {
        type: "number",
        default: 30,
        describe: `capture length (${Diagnostics.PROFILE_MIN_SECONDS}-${Diagnostics.PROFILE_MAX_SECONDS})`,
      })
      .option("label", { type: "string", describe: "short tag added to the file name (e.g. the workload)" }),
  async handler(args) {
    console.error(`capturing ${args.seconds}s CPU profile from ${args.url} ...`)
    const body = await request(args.url, "/global/diagnostics/profile", {
      method: "POST",
      body: JSON.stringify({ seconds: args.seconds, label: args.label }),
    })
    if (body) console.log(JSON.stringify(body, null, 2))
  },
})
