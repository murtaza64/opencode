/* Sidebar search ranking (pure). Three parts, in order:
 * 1. pinned: every pin, always, in pin order (whether or not it matches), so a query never hides a pin;
 * 2. metadata: title or lane matches, from every row this page knows (all hosts, cloud) plus server
 *    results, so a metadata match is never lost to transcript paging or a late transcript response;
 * 3. transcript: rows that match only in their transcript (server results), below every metadata match.
 * Rows keep their own identity key (host/runtime-qualified by the caller); a row appears once. */

export type Searchable = { key: string; title: string; lane?: string }

export type SearchRanked<T> = {
  pinned: { row: T; matches: boolean }[]
  metadata: T[]
  transcript: T[]
}

const matchesText = (row: Searchable, needle: string) =>
  !!needle && [row.title, row.lane].some((value) => value?.toLocaleLowerCase().includes(needle))

/** `known`: every row the page has (any host, cloud); `transcriptHits`: server results (may be truncated or late);
 * `order`: the caller's order within a bucket (e.g. working first, then newest). */
export const rankSearch = <T extends Searchable>(input: {
  query: string
  pinned: T[]
  known: T[]
  transcriptHits: T[]
  order: (a: T, b: T) => number
}): SearchRanked<T> => {
  const needle = input.query.trim().toLocaleLowerCase()
  const pinnedKeys = new Set(input.pinned.map((row) => row.key))
  const seen = new Set(pinnedKeys)
  const take = (rows: T[]) => rows.filter((row) => !seen.has(row.key) && (seen.add(row.key), true))
  // Server results that match by title count as metadata too (e.g. older sessions not in the local list).
  const metadata = take([...input.known, ...input.transcriptHits].filter((row) => matchesText(row, needle))).sort(input.order)
  const transcript = take(input.transcriptHits).sort(input.order)
  return { pinned: input.pinned.map((row) => ({ row, matches: matchesText(row, needle) || input.transcriptHits.some((hit) => hit.key === row.key) })), metadata, transcript }
}
