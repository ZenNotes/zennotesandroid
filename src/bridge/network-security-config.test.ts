import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'

// The app-wide Network Security Configuration (zennotesandroid#140, #141)
// trusts user-installed CAs so a self-hosted server behind a private CA
// connects, and keeps ZenNotes Cloud on the system store alone. Cloud moved
// hosts once already (zennotes.laravel.cloud to zennotes.org), so the Cloud
// hosts the policy names are checked against the URLs the app really uses.

const root = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')
const policy = read('android/app/src/main/res/xml/network_security_config.xml').replace(
  /<!--[\s\S]*?-->/g,
  ''
)

interface TrustConfig {
  cleartext: string | null
  anchors: string[]
  domains: { name: string; includeSubdomains: boolean }[]
}

function parse(tag: 'base-config' | 'domain-config'): TrustConfig[] {
  return [...policy.matchAll(new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)</${tag}>`, 'g'))].map(
    ([, attributes, body]) => ({
      cleartext: /cleartextTrafficPermitted="(\w+)"/.exec(attributes)?.[1] ?? null,
      anchors: [...body.matchAll(/<certificates\s+src="(\w+)"/g)].map((m) => m[1]),
      domains: [...body.matchAll(/<domain([^>]*)>\s*([^<\s]+)\s*<\/domain>/g)].map((m) => ({
        name: m[2],
        includeSubdomains: /includeSubdomains="true"/.test(m[1])
      }))
    })
  )
}

function cloudHosts(): string[] {
  const source = read('src/bridge/mobile-cloud-auth.ts')
  return ['PRODUCTION_CLOUD_BASE_URL', 'LEGACY_CLOUD_BASE_URL'].map((name) => {
    const url = new RegExp(`const ${name} = '([^']+)'`).exec(source)?.[1]
    assert.ok(url, `${name} not found in mobile-cloud-auth.ts`)
    return new URL(url).hostname
  })
}

it('trusts system and user CAs and allows plain HTTP for self-hosted servers', () => {
  const [base, ...extra] = parse('base-config')
  assert.equal(extra.length, 0)
  assert.deepEqual(base.anchors.sort(), ['system', 'user'])
  assert.equal(base.cleartext, 'true')
})

it('keeps every ZenNotes Cloud host on system trust only, over HTTPS', () => {
  const configs = parse('domain-config')
  for (const host of cloudHosts()) {
    const matching = configs.filter((config) =>
      config.domains.some(
        (d) => host === d.name || (d.includeSubdomains && host.endsWith(`.${d.name}`))
      )
    )
    assert.equal(matching.length, 1, `${host} needs exactly one domain-config`)
    assert.deepEqual(matching[0].anchors, ['system'], `${host} must not trust user CAs`)
    assert.equal(matching[0].cleartext, 'false', `${host} must refuse plain HTTP`)
  }
})

it('is the one policy, declared by the main manifest for every build type', () => {
  assert.match(
    read('android/app/src/main/AndroidManifest.xml'),
    /android:networkSecurityConfig="@xml\/network_security_config"/
  )
  assert.doesNotMatch(policy, /<debug-overrides|overridePins/)
})
