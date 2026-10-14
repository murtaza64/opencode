export type StoredImage = { url: string; mime: string; filename?: string }
export type ImageStore = {
  readonly volatile: boolean
  /** Saves the blob under its content hash and records `owner` as a draft referencing it. */
  put(image: StoredImage, owner: string): Promise<string>
  get(key: string): Promise<StoredImage | undefined>
  /** Drops `owner`'s references; a blob is deleted only once no draft references it. */
  remove(keys: string[], owner: string): Promise<void>
}

type Stored = StoredImage & { at: number; owners?: string[] }

const memory = new Map<string, Stored>()

export const createImageStore = (): ImageStore => {
  let volatile = typeof indexedDB === "undefined"
  const database = volatile ? Promise.resolve(undefined) : new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("es-app-images", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("blobs")
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error("Image database is blocked"))
  }).catch(() => {
    volatile = true
    return undefined
  })
  const db = async () => database
  const transact = async (store: IDBDatabase, keys: string[], update: (key: string, current: Stored | undefined) => Stored | undefined) =>
    new Promise<void>((resolve, reject) => {
      const transaction = store.transaction("blobs", "readwrite")
      const blobs = transaction.objectStore("blobs")
      keys.forEach((key) => {
        const request = blobs.get(key)
        request.onsuccess = () => {
          const next = update(key, request.result as Stored | undefined)
          if (next) blobs.put(next, key)
          else blobs.delete(key)
        }
      })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  return {
    get volatile() { return volatile },
    async put(image, owner) {
      const bytes = new TextEncoder().encode(image.url)
      const key = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("")
      const value = (current: Stored | undefined): Stored => ({
        url: image.url,
        mime: image.mime,
        ...(image.filename === undefined ? {} : { filename: image.filename }),
        at: Date.now(),
        owners: [...new Set([...(current?.owners ?? []), owner])],
      })
      const store = await db()
      if (!store) {
        memory.set(key, value(memory.get(key)))
        return key
      }
      await transact(store, [key], (_, current) => value(current))
      return key
    },
    async get(key) {
      const store = await db()
      if (!store) return memory.get(key)
      return new Promise<StoredImage | undefined>((resolve, reject) => {
        const request = store.transaction("blobs").objectStore("blobs").get(key)
        request.onsuccess = () => resolve(request.result as StoredImage | undefined)
        request.onerror = () => reject(request.error)
      })
    },
    async remove(keys, owner) {
      if (!keys.length) return
      // Blobs saved before ownership tracking have no owners and keep the old delete-on-release behavior.
      const release = (current: Stored | undefined) => {
        if (!current?.owners) return undefined
        const owners = current.owners.filter((item) => item !== owner)
        return owners.length ? { ...current, owners } : undefined
      }
      const store = await db()
      if (!store) {
        keys.forEach((key) => {
          const next = release(memory.get(key))
          if (next) memory.set(key, next)
          else memory.delete(key)
        })
        return
      }
      await transact(store, keys, (_, current) => release(current))
    },
  }
}
