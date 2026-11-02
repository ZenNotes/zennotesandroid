import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { KeyboardLift } from './keyboard-lift.ts'

describe("A tablet's keyboard lift", () => {
  it('is nothing when the WebView shrank for the whole keyboard (the Android tablet walk)', () => {
    // 800 x 1280 CSS px; the keyboard is 328 px and the viewport drops to 952.
    const lift = new KeyboardLift(800, 1280)
    assert.equal(lift.shown(328, 1280), 328, 'before the viewport has shrunk')
    assert.equal(lift.resized(800, 952), 0, 'once it has, the toolbar docks at the bottom')
    assert.equal(lift.shown(328, 952), 0, 'the settled did-show agrees')
    assert.equal(lift.hidden(), 0)
    assert.equal(lift.resized(800, 1280), 0)
  })

  it('is the whole keyboard where the WebView keeps its height', () => {
    const lift = new KeyboardLift(800, 1280)
    assert.equal(lift.shown(328, 1280), 328)
    assert.equal(lift.resized(800, 1280), 328)
  })

  it('does not take a shrink that lands before the keyboard event for the resting height', () => {
    const lift = new KeyboardLift(800, 1280)
    assert.equal(lift.resized(800, 952), 0)
    assert.equal(lift.shown(328, 952), 0)
  })

  it('keeps a resting height per width, so a rotation under the keyboard stays docked', () => {
    const lift = new KeyboardLift(800, 1280)
    assert.equal(lift.resized(1280, 800), 0)
    assert.equal(lift.shown(300, 800), 300)
    assert.equal(lift.resized(1280, 500), 0)
    assert.equal(lift.resized(800, 980), 0, 'rotated back with the keyboard still up')
    lift.hidden()
    assert.equal(lift.resized(800, 1280), 0)
    assert.equal(lift.shown(328, 952), 0)
    // A width first met with the keyboard up counts as shrunk for all of it.
    const fresh = new KeyboardLift(800, 1280)
    fresh.shown(328, 1280)
    assert.equal(fresh.resized(1280, 472), 0)
  })

  it('feeds the tablet rules only, from every keyboard event and resize', () => {
    const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')
    assert.match(main, /window\.addEventListener\('resize', \(\) => setLift\(lift\.resized\(window\.innerWidth, window\.innerHeight\)\)\)/)
    assert.match(main, /'keyboardWillShow', \(info\) => \{\n\s+html\.classList\.add\('zn-kb-open'\)\n\s+setLift\(lift\.shown\(info\.keyboardHeight, window\.innerHeight\)\)/)
    assert.match(main, /'keyboardDidShow', \(info\) => \{\n\s+setLift\(lift\.shown\(info\.keyboardHeight, window\.innerHeight\)\)/)
    assert.match(main, /setLift\(lift\.hidden\(\)\)/)
    const css = readFileSync(new URL('./mobile.css', import.meta.url), 'utf8')
    const readers = css.split('\n').filter((line) => line.includes('--zn-kb-height'))
    assert.equal(readers.length, 2)
    assert.match(css, /\.zn-kb-noresize \.zn-editor-toolbar \{\n\s+bottom: var\(--zn-kb-height, 0px\);/)
    assert.match(css, /\.zn-mobile\.zn-kb-open:not\(\.zn-phone\) \.cm-scroller \{\n\s+padding-bottom: calc\(var\(--zn-kb-height, 0px\) \+ 4rem\) !important;/)
  })

  it("rests on the Android plugin's resize mode being a no-op", () => {
    const plugin = readFileSync(
      new URL(
        '../../node_modules/@capacitor/keyboard/android/src/main/java/com/capacitorjs/plugins/keyboard/KeyboardPlugin.java',
        import.meta.url
      ),
      'utf8'
    )
    assert.match(plugin, /public void setResizeMode\(PluginCall call\) \{\n\s+call\.unimplemented\(\);/)
  })
})
