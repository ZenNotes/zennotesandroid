import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { DRAWER_CLOSE_MS, openDrawerRowToRead, type DrawerOpenSteps } from './drawer-open.ts'

function recorder(): { log: string[]; steps: DrawerOpenSteps } {
  const log: string[] = []
  let held = false
  return {
    log,
    steps: {
      close: () => log.push(`close held=${held}`),
      wait: async (ms) => { log.push(`wait ${ms} held=${held}`) },
      openToRead: async (open) => {
        held = true
        log.push('arm')
        try {
          return await open()
        } finally {
          held = false
          log.push('settle')
        }
      }
    }
  }
}

describe('openDrawerRowToRead', () => {
  it('arms the hold before the drawer closes and keeps it through the open', async () => {
    const { log, steps } = recorder()
    const result = await openDrawerRowToRead(async () => {
      log.push('open')
      return 'Project Atlas.md'
    }, steps)
    assert.equal(result, 'Project Atlas.md')
    assert.deepEqual(log, ['arm', 'close held=true', `wait ${DRAWER_CLOSE_MS} held=true`, 'open', 'settle'])
  })

  it('settles the hold when the open fails, and passes the failure on', async () => {
    const { log, steps } = recorder()
    await assert.rejects(
      openDrawerRowToRead(async () => { throw new Error('gone') }, steps),
      /gone/
    )
    assert.equal(log.at(-1), 'settle')
  })
})

describe('MobileDrawer rows', () => {
  const source = readFileSync(new URL('./MobileDrawer.tsx', import.meta.url), 'utf8')

  it('open notes, databases and files to read', () => {
    assert.match(source, /onClick=\{\(\) => read\(tabPath\)\}/)
    assert.match(source, /onClick=\{\(\) => read\(n\.path\)\}/)
    assert.match(source, /onClick=\{\(\) => read\(file\.path\)\}/)
  })

  it('never open a listed note around the read-open guard', () => {
    assert.doesNotMatch(source, /go\(\(\) => openNote\(/)
  })
})
