import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

test('captured native work never resumes after a cancelled or failed workspace change', async () => {
  const vault = {}, state = { mode: 'local', remoteProfileId: null, generation: 1, transitioning: false }
  const { captureMobileWorkspace } = await loadMobileModule('./src/ui-mobile/workspace-context', {
    '@zennotes/app-core/workspace': { getWorkspaceSnapshot: () => ({ ...state }) },
    '../bridge/mobile-bridge': { activeVault: () => vault }
  })
  const old = captureMobileWorkspace()
  assert.equal(old.isCurrent(), true)
  state.generation++; state.transitioning = true
  const during = captureMobileWorkspace()
  assert.equal(old.isCurrent(), false)
  state.transitioning = false
  assert.equal(old.isCurrent(), false)
  assert.equal(during.isCurrent(), false)
  assert.equal(captureMobileWorkspace().isCurrent(), true)
})
