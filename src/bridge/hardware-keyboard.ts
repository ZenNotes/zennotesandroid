/**
 * Whether a typing keyboard is attached (HardwareKeyboardPlugin.java). Android-only
 * and best-effort, like EdgeSwipe: where the plugin cannot answer, the answer stays
 * "no", which is exactly how a device with no keyboard behaves.
 */
import { registerPlugin } from '@capacitor/core'

export interface HardwareKeyboardSource {
  isConnected(): Promise<{ connected: boolean }>
  addListener(
    event: 'change',
    listener: (state: { connected: boolean }) => void
  ): Promise<{ remove(): Promise<void> }>
}

let connected = false

export function hardwareKeyboardConnected(): boolean {
  return connected
}

/** Follow the keyboard coming and going. `changed` runs on every real change,
 *  and returns a function that stops listening. */
export function watchHardwareKeyboard(source: HardwareKeyboardSource, changed: () => void): () => void {
  let live = true
  const apply = (next: boolean): void => {
    if (!live || next === connected) return
    connected = next
    changed()
  }
  const listening = source.addListener('change', (state) => apply(state.connected))
  void source.isConnected().then((state) => apply(state.connected)).catch(() => {})
  void listening.catch(() => {})
  return () => {
    live = false
    void listening.then((handle) => handle.remove()).catch(() => {})
  }
}

export const nativeHardwareKeyboard = registerPlugin<HardwareKeyboardSource>('HardwareKeyboard')
