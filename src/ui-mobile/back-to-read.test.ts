import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

describe('Back on the phone layout', () => {
  const source = readFileSync(new URL('./MobileShell.tsx', import.meta.url), 'utf8')

  it('goes back through history to read, under the read-open hold', () => {
    assert.match(source, /function goBackToRead\(\): void \{\n\s+void openToRead\(\(\) => runAppCommand\('nav\.back'\)\)/)
  })

  it('takes that path from the header chevron and from the system Back', () => {
    assert.equal(source.match(/goBackToRead\(\)/g)?.length, 3) // the definition and two callers
    assert.doesNotMatch(source, /runCommand\('nav\.back'\)/)
  })
})
