import { crc32, deflateSync } from "node:zlib"
import { directory } from "./composer-fixture.mjs"

const fill = (text, bytes) => text.repeat(Math.ceil(bytes / text.length)).slice(0, bytes)
const png = (width, height, seed) => {
  const stride = width * 4 + 1
  const pixels = Buffer.alloc(stride * height, 255)
  for (let y = 0; y < height; y++) {
    pixels[y * stride] = 0
    for (let x = 0; x < width; x += 15) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const offset = y * stride + 1 + x * 4
      pixels[offset] = seed & 255
      pixels[offset + 1] = (seed >>> 8) & 255
      pixels[offset + 2] = (seed >>> 16) & 255
    }
  }
  const chunk = (type, bytes) => {
    const result = Buffer.alloc(bytes.length + 12)
    result.writeUInt32BE(bytes.length)
    result.write(type, 4)
    bytes.copy(result, 8)
    result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return (
    "data:image/png;base64," +
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(pixels)),
      chunk("IEND", Buffer.alloc(0)),
    ]).toString("base64")
  )
}

export const createLargeHistory = () => {
  const images = [
    [1852, 2000],
    [1069, 2000],
    [526, 2000],
    [1852, 2000],
    [2000, 1940],
    [2000, 1070],
    [1852, 2000],
    [1324, 2000],
    [1213, 2000],
  ].map(([width, height], index) => png(width, height, index + 1))
  let user = 0
  let assistant = 0
  let diff = 0
  return Array.from({ length: 360 }, (_, index) => {
    const id = `msg_${String(index).padStart(6, "0")}`
    const base = { sessionID: "ses_a", messageID: id }
    if (index % 7 === 0) {
      const userIndex = user
      const summary =
        user++ < 49
          ? {
              diffs: Array.from({ length: Math.min(42, 2053 - diff) }, () => {
                const item = diff++
                return {
                  file: `src/fixture-${item}.json`,
                  additions: 10,
                  deletions: 1,
                  status: "modified",
                  patch: fill(
                    `+  "fixture-${item}": "synthetic content retained only as historical diff metadata........",\n`,
                    item === 0 ? 11_869_097 : 14_973,
                  ),
                }
              }),
            }
          : undefined
      return {
        info: {
          id,
          sessionID: "ses_a",
          role: "user",
          agent: "build",
          model: { providerID: "fixture", modelID: "test" },
          time: { created: index * 1000 },
          summary,
        },
        parts: [
          { ...base, id: `prt_${id}_text`, type: "text", text: fill(`Synthetic request ${index}. `, 250) },
          ...(userIndex < 27
            ? [
                {
                  ...base,
                  id: `prt_${id}_synthetic`,
                  type: "text",
                  synthetic: true,
                  text: fill(
                    "Synthetic hidden context | retained | for fixture only\n",
                    [119092, 92626, 67030, 52575, 31606, 23855][userIndex] ?? 6280,
                  ),
                },
              ]
            : []),
        ],
      }
    }
    const n = assistant++
    const tool = n < 94 ? "read" : n < 143 ? "apply_patch" : n < 256 ? "bash" : "task"
    const output = fill(`Synthetic ${tool} result ${n}.\n`, tool === "read" ? 8000 : 1800)
    return {
      info: {
        id,
        sessionID: "ses_a",
        role: "assistant",
        parentID: `msg_${String(index - (index % 7)).padStart(6, "0")}`,
        agent: "build",
        mode: "build",
        providerID: "fixture",
        modelID: "test",
        time: { created: index * 1000, completed: index * 1000 + 900 },
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [
        { ...base, id: `prt_${id}_step`, type: "step-start" },
        {
          ...base,
          id: `prt_${id}_tool`,
          type: "tool",
          tool,
          callID: `call_${index}`,
          state: {
            status: "completed",
            input: {
              filePath: "/fixture/source.ts",
              command: "synthetic-check",
              description: "Synthetic fixture",
              subagent_type: "general",
            },
            output,
            title: "Synthetic check",
            metadata: { output },
            time: { start: index * 1000 + 1, end: index * 1000 + 2 },
            attachments:
              n < 9
                ? [
                    {
                      ...base,
                      id: `prt_${id}_image`,
                      type: "file",
                      mime: "image/png",
                      url: images[n],
                      filename: `fixture-${n}.png`,
                    },
                  ]
                : undefined,
          },
        },
        ...(n < 193
          ? [
              {
                ...base,
                id: `prt_${id}_reasoning`,
                type: "reasoning",
                text: "",
                metadata: { fixture: fill(`opaque-${n}-`, 2644) },
                time: { start: index * 1000 + 3, end: index * 1000 + 4 },
              },
            ]
          : []),
        ...(n % 3 === 0 || index === 359
          ? [
              {
                ...base,
                id: `prt_${id}_text`,
                type: "text",
                text:
                  index === 359
                    ? "LATEST_LARGE_HISTORY_SENTINEL"
                    : fill(
                        `## Synthetic result ${index}\n\nChecked **fixture** content and retained history.\n\n`,
                        720,
                      ),
                time: { start: index * 1000 + 5, end: index * 1000 + 900 },
              },
            ]
          : []),
      ],
    }
  })
}

export const withoutSummaryPatches = (messages) =>
  messages.map((message) => {
    if (message.info.role !== "user" || !message.info.summary) return message
    return {
      ...message,
      info: {
        ...message.info,
        summary: {
          ...message.info.summary,
          diffs: message.info.summary.diffs.map(({ patch, ...metadata }) => metadata),
        },
      },
    }
  })
