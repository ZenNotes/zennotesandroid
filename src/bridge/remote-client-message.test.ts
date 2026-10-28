import { describe, expect, it } from 'vitest'
import { connectionErrorMessage } from './remote-client'

describe('connectionErrorMessage', () => {
  it('never points an Android user at the iPhone Local Network setting', () => {
    for (const url of ['http://192.168.1.20:7878', 'https://notes.example.com']) {
      const text = connectionErrorMessage(url, new Error('Failed to fetch'))
      expect(text).not.toMatch(/Local Network|Privacy & Security/)
      expect(text).toContain(`Could not connect to the ZenNotes server at ${url}.`)
      expect(text).toContain('Could not reach the server: Failed to fetch.')
    }
  })

  it('says where to install a certificate authority for an https server only', () => {
    expect(connectionErrorMessage('https://notes.example.com', null)).toContain(
      'Install a certificate'
    )
    expect(connectionErrorMessage('http://192.168.1.20:7878', null)).not.toContain('certificate')
  })
})
