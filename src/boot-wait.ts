/**
 * How long boot waits for a native answer it can do without.
 *
 * Boot awaits a few native bridge calls before anything renders: bootstrap's
 * restore of the preferences mirrored in native storage, then the app
 * version, the Cloud sign-in link listeners and the Share sheet's waiting
 * captures. A call that never answers left a blank page with nothing to do
 * but quit: after about eleven rapid Settings Layout reloads in one process,
 * the page stopped inside bootstrap's restore, before main.tsx ever loaded,
 * and a reload did not bring it back. Each of these waits now ends after
 * BOOT_NATIVE_WAIT_MS and boot goes on without the answer, logging once. An
 * answer that comes late is never applied over what boot already decided.
 * The vault itself is not bounded: without it there is nothing to show.
 *
 * Measured on the API 37 emulator with the release build, from bootstrap's
 * script to main.tsx's first request: the preferences restore took 13 to 28
 * ms on a cold launch (165 ms on the first launch after install) and 5 to 6
 * ms on a reload. Two seconds is more than twelve times the slowest of those,
 * and still short enough that a stalled bridge costs a launch seconds instead
 * of the whole app. Same helper as the iPhone shell's.
 */
export const BOOT_NATIVE_WAIT_MS = 2000

export interface BootTimer {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const browserTimer: BootTimer = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export type BootAnswer<T> = { inTime: true; value: T } | { inTime: false }

/** Wait for `work` at most `ms`. A rejection in time rejects; after the wait
 *  ends, the answer (or failure) is dropped and `onLate` has been called once. */
export function settleWithin<T>(
  work: Promise<T>,
  ms: number,
  onLate: () => void,
  timer: BootTimer = browserTimer
): Promise<BootAnswer<T>> {
  return new Promise((resolve, reject) => {
    let done = false
    const handle = timer.set(() => {
      if (done) return
      done = true
      onLate()
      resolve({ inTime: false })
    }, ms)
    work.then(
      (value) => {
        if (done) return
        done = true
        timer.clear(handle)
        resolve({ inTime: true, value })
      },
      (error: unknown) => {
        if (done) return
        done = true
        timer.clear(handle)
        reject(error)
      }
    )
  })
}

/** Boot's wait for a native step, named for the one log line it may write. */
export function waitAtBoot<T>(step: string, work: Promise<T>): Promise<BootAnswer<T>> {
  return settleWithin(work, BOOT_NATIVE_WAIT_MS, () => {
    console.warn(`ZenNotes boot: ${step} did not answer within ${BOOT_NATIVE_WAIT_MS} ms; continuing without it`)
  })
}
