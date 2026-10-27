/** An agent's request text as Markdown source in which any raw HTML stays literal text: `<` outside
 * code spans and fenced blocks is backslash-escaped, so only Markdown formatting renders (code keeps
 * its exact characters). The text is otherwise unchanged: nothing is added, fenced or rewritten. */
export const requestMarkdown = (text: string) => {
  let fence = ""
  return text.split("\n").map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = ""
      return line
    }
    if (marker) { fence = marker; return line }
    // Indented code (4+ spaces) renders verbatim already.
    if (/^( {4}|\t)/.test(line)) return line
    // Outside inline code spans (runs of backticks closed by the same run), escape `<`.
    return line.split(/(`+[^`]*?`+)/).map(part => /^(`+)[^`]*?\1$/.test(part) ? part : part.replace(/</g, "\\<")).join("")
  }).join("\n")
}
