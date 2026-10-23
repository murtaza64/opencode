/* Plain text with its http(s) URLs as real links. Links carry target=_blank so the shared
 * router decides: es-app routes navigate in place (installAppLinks, desktop window handler)
 * and everything else opens in the external browser instead of replacing the app. */
import { For } from "solid-js"
import { linkSegments } from "../link-url"

export const LinkedText = (props: { text: string }) =>
  <For each={linkSegments(props.text)}>{segment => "href" in segment
    ? <a href={segment.href} target="_blank" rel="noopener noreferrer"><bdi dir="ltr">{segment.text}</bdi></a>
    : segment.text}</For>
