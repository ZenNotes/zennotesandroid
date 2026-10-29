/**
 * Bootstrap's restore of the preferences mirrored in native storage
 * (bootstrap.ts): WebView storage alone is not trusted to survive, so at boot
 * a value native storage holds is put back into localStorage, and a value
 * only localStorage holds is copied to native storage.
 *
 * Reading and applying are split so a late answer can be dropped whole
 * (boot-wait.ts): the reads run first and write nothing; the writes happen in
 * one synchronous step, only when every read answered in time. If boot gave
 * up waiting, the app has been running on what localStorage had and may have
 * changed some of it since, so applying even part of a late answer could put
 * an older value back over a newer one. Ignoring it is the safe choice: the
 * native copy catches up from localStorage through the mirror, which is
 * installed either way. Kept apart from Capacitor so node --test covers it.
 */

export interface MirroredPreference {
  /** The localStorage key the app reads. */
  readonly web: string
  /** Its copy in native Preferences. */
  readonly native: string
}

export interface NativeReader {
  get(options: { key: string }): Promise<{ value: string | null }>
}

export interface WebStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Every native value, read without writing anything. */
export async function readNativePreferences(
  pairs: readonly MirroredPreference[],
  native: NativeReader
): Promise<Map<string, string | null>> {
  const values = await Promise.all(pairs.map((pair) => native.get({ key: pair.native })))
  return new Map(pairs.map((pair, i) => [pair.native, values[i]?.value ?? null]))
}

/** Apply a restore that answered in time: native wins, else localStorage's
 *  value goes to native. `restored` hears each value put back, in order. */
export function applyNativePreferences(
  pairs: readonly MirroredPreference[],
  nativeValues: ReadonlyMap<string, string | null>,
  web: WebStorage,
  writeNative: (key: string, value: string) => void,
  restored: (pair: MirroredPreference, value: string) => void = () => {}
): void {
  for (const pair of pairs) {
    const nativeValue = nativeValues.get(pair.native) ?? null
    if (nativeValue) {
      web.setItem(pair.web, nativeValue)
      restored(pair, nativeValue)
      continue
    }
    const webValue = web.getItem(pair.web)
    if (webValue) writeNative(pair.native, webValue)
  }
}
