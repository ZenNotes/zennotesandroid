/**
 * How long the read-open hold stays armed over the restore landing.
 *
 * A note opened to read arms the hold for READ_OPEN_WAIT_MS (keyboard-hold.ts),
 * then lets it settle. The restore landing (usePhoneLayoutBoot) is different:
 * the workspace has restored, but the restored note's text may still be
 * loading, and when its editor mounts core focuses it (the sidebar it closed
 * had handed the focus over). A fixed wait could lapse before a slow vault
 * shows the note, so the landing keeps the hold armed until its note is on
 * screen, re-arming before each wait runs out, with a generous cap so a note
 * that never appears cannot hold the keyboard forever. A touch ends it at
 * once, as it ends every hold. Kept apart from the DOM so node --test covers
 * it.
 */

/** The landing never holds the keyboard longer than this. */
export const LANDING_HOLD_CAP_MS = 15000

export interface Rearmable {
  arm(): void
  opened(): void
}

export interface LandingClock {
  now(): number
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export type LandingEnd = 'settled' | 'cap' | 'touched'

/** Hold through `settled`, re-arming every `rearmMs`, until it resolves, the
 *  cap passes or `touched()` says the person touched the screen; then let the
 *  hold settle. */
export function holdUntilSettled(
  hold: Rearmable,
  settled: Promise<unknown>,
  options: { rearmMs: number; capMs?: number; clock: LandingClock; touched: () => boolean }
): Promise<LandingEnd> {
  const { rearmMs, clock, touched } = options
  const capMs = options.capMs ?? LANDING_HOLD_CAP_MS
  const started = clock.now()
  hold.arm()
  return new Promise((resolve) => {
    let ended = false
    let handle: unknown = null
    const end = (how: LandingEnd): void => {
      if (ended) return
      ended = true
      if (handle !== null) clock.clear(handle)
      if (how !== 'touched') hold.opened()
      resolve(how)
    }
    const tick = (): void => {
      handle = null
      if (touched()) return end('touched')
      if (clock.now() - started >= capMs) return end('cap')
      hold.arm()
      handle = clock.set(tick, Math.min(rearmMs, capMs - (clock.now() - started)))
    }
    handle = clock.set(tick, Math.min(rearmMs, capMs))
    settled.then(() => end('settled'), () => end('settled'))
  })
}
