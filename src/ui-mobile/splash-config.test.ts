import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import test from 'node:test'

const native = new URL('../../android/app/src/main/', import.meta.url)
test('all Android versions use the same aspect-preserving splash (#55)', () => {
  const theme = readFileSync(new URL('res/values/styles.xml', native), 'utf8')
  assert.match(theme, /name="windowSplashScreenAnimatedIcon">@drawable\/zn_splash_icon/)
  assert.match(theme, /name="postSplashScreenTheme">@style\/AppTheme.NoActionBar/)
  const path = new URL('res/drawable/zn_splash_icon.xml', native)
  assert.ok(existsSync(path))
  const icon = readFileSync(path, 'utf8')
  assert.match(icon, /android:width="128dp" android:height="128dp"/)
  assert.match(icon, /@mipmap\/ic_launcher_foreground/)
})
test('splash installs before BridgeActivity switches theme, without a second plugin splash', () => {
  const activity = readFileSync(new URL('java/md/zennotes/MainActivity.java', native), 'utf8')
  const install = activity.indexOf('SplashScreen.installSplashScreen(this)')
  assert.ok(install >= 0 && install < activity.indexOf('super.onCreate(savedInstanceState)'))
  assert.match(readFileSync(new URL('../../capacitor.config.ts', import.meta.url), 'utf8'), /launchShowDuration: 0/)
})
