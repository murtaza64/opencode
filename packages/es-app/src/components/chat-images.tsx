import { createSignal, For, Show } from "solid-js"
import { imageSize } from "../image-size"

export type ChatImage = { url: string; mime: string; filename?: string }

const single = { width: 360, height: 280 }
const rowHeight = 160
const shown = 4

// Images of one user message, shared by the outgoing bubble and the transcript
// so acceptance never changes an image's element size. Each box is sized from
// the image header before decode; only offscreen history images load lazily.
export const ChatImages = (props: { images?: readonly ChatImage[]; lazy?: boolean }) => {
  const images = () => (props.images ?? []).filter((image) => image.mime.startsWith("image/") && safe(image.url))
  const visible = () => images().length > shown ? images().slice(0, shown - 1) : images()
  const [open, setOpen] = createSignal<number>()
  let dialog: HTMLDialogElement | undefined
  const show = (index: number) => {
    setOpen(index)
    if (!dialog?.open) dialog?.showModal()
  }
  const step = (delta: number) => setOpen((index) => ((index ?? 0) + delta + images().length) % images().length)
  return (
    <Show when={images().length}>
      <div class="chat-images" role="group" aria-label={images().length === 1 ? "Image" : `${images().length} images`}
        data-count={images().length > 1 ? "many" : "one"}>
        <For each={visible()}>
          {(image, index) => {
            const size = imageSize(image.url)
            const box = size && fit(size, images().length > 1)
            return (
              <img class="chat-image" src={image.url} alt={label(image, index())} width={size?.width} height={size?.height}
                loading={props.lazy && !seen.has(image.url) ? "lazy" : "eager"} decoding={seen.has(image.url) ? "sync" : "async"}
                draggable={false} tabIndex={0} title="Open full size" onLoad={() => remember(image.url)}
                style={box ? { width: `${box.width}px`, "aspect-ratio": `${size!.width} / ${size!.height}` } : undefined}
                onClick={() => show(index())}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return
                  event.preventDefault()
                  show(index())
                }} />
            )
          }}
        </For>
        <Show when={images().length > shown}>
          <button type="button" class="chat-image-more" aria-label={`Open ${images().length - shown + 1} more images`}
            onClick={() => show(shown - 1)}>+{images().length - shown + 1}</button>
        </Show>
        <dialog ref={dialog} class="chat-image-viewer" aria-label="Image viewer" onClose={() => setOpen(undefined)}
          onClick={(event) => { if (event.target === event.currentTarget) dialog?.close() }}
          onKeyDown={(event) => {
            if (images().length < 2) return
            if (event.key === "ArrowRight") step(1)
            if (event.key === "ArrowLeft") step(-1)
          }}>
          <Show when={open() !== undefined && images()[open()!]}>
            {(image) => <img src={image().url} alt={label(image(), open()!)} decoding="async" />}
          </Show>
          <Show when={images().length > 1}>
            <p class="chat-image-viewer-count">{(open() ?? 0) + 1} / {images().length}</p>
          </Show>
          <button type="button" class="chat-image-viewer-close" aria-label="Close image" onClick={() => dialog?.close()}>Close</button>
        </dialog>
      </div>
    </Show>
  )
}

// URLs already decoded in this tab (a just-sent image): the transcript echo paints them in its first frame.
const seen = new Set<string>()
const remember = (url: string) => {
  seen.delete(url)
  seen.add(url)
  if (seen.size > 50) seen.delete(seen.values().next().value!)
}

const label = (image: ChatImage, index: number) => image.filename || `Image ${index + 1}`

// Only inline bytes or ordinary web URLs; never a scriptable scheme.
const safe = (url: string) => /^data:image\/[\w.+-]+;base64,/.test(url) || /^(https?|blob):/.test(url)

const fit = (size: { width: number; height: number }, many: boolean) => {
  const scale = many ? Math.min(1, rowHeight / size.height) : Math.min(1, single.width / size.width, single.height / size.height)
  return { width: Math.max(1, Math.round(size.width * scale)) }
}
