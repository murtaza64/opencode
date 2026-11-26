import katex from "katex"
import { Marked, type MarkedExtension, type Tokens } from "marked"
import markedShiki from "marked-shiki"

export function createMarkdownParser(highlight: (code: string, language: string) => string | Promise<string>) {
  return new Marked(
    {
      renderer: {
        link({ href, title, text }) {
          const titleAttr = title ? ` title="${title}"` : ""
          return `<a href="${href}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`
        },
        // Task items and paragraphs with bold text carry a data attribute, so Markdown styles need no `:has()`
        // (each `:has()` rule restyled the whole transcript on every streamed delta). Otherwise marked's default.
        listitem(item) {
          if (!item.task) return false
          return `<li data-task="">${this.parser.parse(item.tokens)}</li>\n`
        },
        paragraph({ tokens }) {
          if (!hasStrong(tokens)) return false
          return `<p data-strong="">${this.parser.parseInline(tokens)}</p>\n`
        },
      },
    },
    katexExtension,
    markedShiki({ highlight }),
  )
}

const hasStrong = (tokens: Tokens.Generic[] | undefined): boolean =>
  !!tokens?.some((token) => token.type === "strong" || (token.type === "html" && /<strong[\s>]/i.test(token.raw)) || hasStrong(token.tokens))

const inlineMathRegex = /^\\\(((?:\\.|[^\\\n])*?)\\\)/
const blockMathRegex = /^\$\$\n([\s\S]+?)\n\$\$(?:\n|$)/

const katexExtension: MarkedExtension = {
  extensions: [
    {
      name: "inlineKatex",
      level: "inline",
      start(src) {
        const index = src.indexOf("\\(")
        if (index === -1) return
        return index
      },
      tokenizer(src) {
        const match = src.match(inlineMathRegex)
        if (!match) return
        return {
          type: "inlineKatex",
          raw: match[0],
          text: match[1].trim(),
          displayMode: false,
        }
      },
      renderer: renderKatexToken,
    },
    {
      name: "blockKatex",
      level: "block",
      tokenizer(src) {
        const match = src.match(blockMathRegex)
        if (!match) return
        return {
          type: "blockKatex",
          raw: match[0],
          text: match[1].trim(),
          displayMode: true,
        }
      },
      renderer: renderKatexToken,
    },
  ],
}

function renderKatexToken(token: Tokens.Generic) {
  return katex.renderToString(typeof token.text === "string" ? token.text : "", {
    displayMode: token.displayMode === true,
    throwOnError: false,
  })
}
