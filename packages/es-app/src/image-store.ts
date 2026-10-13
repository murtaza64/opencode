export type StoredImage = { url: string; mime: string; filename?: string }
export type ImageStore = {
  readonly volatile: boolean
  put(image: StoredImage): Promise<string>
  get(key: string): Promise<StoredImage | undefined>
  remove(keys: string[]): Promise<void>
}

const memory = new Map<string, StoredImage & { at: number }>()

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
  return {
    get volatile() { return volatile },
    async put(image) {
      const bytes = new TextEncoder().encode(image.url)
      const key = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("")
      const value = { url: image.url, mime: image.mime, ...(image.filename === undefined ? {} : { filename: image.filename }), at: Date.now() }
      const store = await db()
      if (!store) {
        memory.set(key, value)
        return key
      }
      await new Promise<void>((resolve, reject) => {
        const transaction = store.transaction("blobs", "readwrite")
        transaction.objectStore("blobs").put(value, key)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
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
    async remove(keys) {
      const store = await db()
      if (!store) {
        keys.forEach((key) => memory.delete(key))
        return
      }
      if (!keys.length) return
      await new Promise<void>((resolve, reject) => {
        const transaction = store.transaction("blobs", "readwrite")
        keys.forEach((key) => transaction.objectStore("blobs").delete(key))
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
    },
  }
}
