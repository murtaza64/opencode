/* The wallpaper's Gaussian blur off the Electron main thread: up to ~0.6 s of pixel work on a 5K wallpaper would
 * otherwise stall every window. The worker runs gaussianBlur's own source (eval), so no extra file has to load from
 * the app archive; if a worker cannot start, the blur runs inline as before. */
import { Worker } from "node:worker_threads"
import { gaussianBlur } from "./appearance"

const SOURCE = `const { parentPort, workerData } = require("node:worker_threads")
const gaussianBlur = ${gaussianBlur.toString()}
gaussianBlur(new Uint8Array(workerData.buffer), workerData.width, workerData.height, workerData.sigma)
parentPort.postMessage(workerData.buffer, [workerData.buffer])`

/** `pixels` blurred (a new array); the caller's array is not changed. */
export const blurOffMain = (pixels: Uint8Array, width: number, height: number, sigma: number) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const buffer = pixels.slice().buffer
    const worker = new Worker(SOURCE, { eval: true, workerData: { buffer, width, height, sigma }, transferList: [buffer] })
    worker.once("message", (result: ArrayBuffer) => { resolve(new Uint8Array(result)); void worker.terminate() })
    worker.once("error", reject)
    worker.once("exit", (code) => reject(new Error(`blur worker exited ${code}`)))
  }).catch(() => gaussianBlur(pixels.slice(), width, height, sigma))
