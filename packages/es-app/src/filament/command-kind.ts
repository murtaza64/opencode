/* Classifies a shell command by the program that does the work, so a bash tool call can carry a
 * program-specific glyph. Shared with chip owners so gutter and chips agree. Pure; no execution. */
export type CommandKind = "git" | "jj" | "gh" | "es" | "aws" | "test" | "http" | "container" | "search" | "build" | "shell"

const WRAPPERS = new Set(["sudo", "env", "time", "nice", "nohup", "xvfb-run", "command", "exec", "timeout"])
const KINDS: [CommandKind, RegExp][] = [
  ["git", /^git$/],
  ["jj", /^jj$/],
  ["gh", /^gh$/],
  ["es", /^(es|es-federation)$/],
  ["aws", /^(aws|duo)$/],
  ["test", /^(bun|node|npm|pnpm|yarn|npx|bunx|pytest|vitest|jest|uv)$/],
  ["http", /^(curl|wget|http|httpie|xh)$/],
  ["container", /^(docker|podman|kubectl|helm|k9s|compose)$/],
  ["search", /^(rg|grep|ag|find|fd|ls|cat|head|tail|wc)$/],
  ["build", /^(make|cargo|go|tsc|tsgo|gradle|gradlew|xcodebuild|swift|mvn)$/],
]

// The first non-wrapper program after leading `cd …`, env assignments and `(`. Pipelines and
// `&&` chains are read left to right; the first real program wins.
export const commandKind = (command: string | undefined): CommandKind => {
  if (!command) return "shell"
  // Separators are split off so `cd /tmp;` and `foo|bar` tokenize as words plus separators.
  const words = command.replace(/^\s*\(+/, "").replace(/(&&|\|\||[;|()])/g, " $1 ").split(/\s+/)
  let skipUntilSep = false
  for (const raw of words) {
    const word = raw.replace(/^['"]|['"]$/g, "")
    if (!word || word === "(" || word === ")") continue
    if (skipUntilSep) {
      if (word === "&&" || word === ";" || word === "||" || word === "|") skipUntilSep = false
      continue
    }
    if (word === "&&" || word === ";" || word === "||" || word === "|") continue
    if (word === "cd") { skipUntilSep = true; continue }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    const program = word.split("/").pop()!.toLowerCase()
    if (WRAPPERS.has(program) || /^-/.test(program)) continue
    // `bun test` / `bun run test` are tests; `bun x vite` is a build; plain `node script` counts as test-ish runtime.
    for (const [kind, re] of KINDS) if (re.test(program)) return kind
    return "shell"
  }
  return "shell"
}
