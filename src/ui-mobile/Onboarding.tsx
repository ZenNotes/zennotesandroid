/**
 * First-open experience. A fresh install used to silently create an on-device
 * vault and drop the user on a Home screen of demo-note tails with one
 * unlabeled circle (which reads as a loading spinner) — confusing enough that
 * real first-time users bounced. This overlay runs BEFORE the vault exists:
 * a welcome beat, then the one decision that must come first — where notes
 * live (iCloud vs. this device) — so sync is an explicit choice, not a
 * surprise. Everything else is taught in-app: the seeded welcome note opens
 * automatically and a one-time hint labels the circle.
 *
 * Returning users are detected two ways: an existing local vault/remote
 * profile skips everything (isFirstRun), and iCloud vaults surviving a
 * reinstall short-circuit the overlay and reopen their vault untouched.
 */
import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { isFirstRun } from '../bridge/mobile-bridge'
import { setStoragePref, type VaultStorage } from '../bridge/icloud'
import ensoUrl from '../assets/enso.png'

/** Set when the overlay completed this install; guards against re-showing. */
const ONBOARDED_KEY = 'zn-mobile:onboarded'
/** Consumed by the shell's phone-layout boot: open the welcome note once. */
export const WELCOME_PENDING_KEY = 'zn-mobile:welcome-pending'
/** Consumed by MobileNav: show the "everything starts here" hint until the
 *  circle is first tapped. */
export const FAB_HINT_KEY = 'zn-mobile:fab-hint'

const deviceNoun = window.innerWidth >= 768 ? 'tablet' : 'phone'

interface OnboardingProps {
  onDone: (choice: VaultStorage) => void
}

function OnboardingOverlay({ onDone }: OnboardingProps): React.JSX.Element {
  const [step, setStep] = useState<'welcome' | 'storage'>('welcome')

  return (
    <div className="zn-onboard" data-step={step}>
      {step === 'welcome' ? (
        <div className="zn-onboard-page">
          <img className="zn-onboard-enso" src={ensoUrl} alt="" aria-hidden="true" />
          <h1>Welcome to ZenNotes</h1>
          <p className="zn-onboard-tagline">
            Quiet, focused notes.
            <br />
            Plain Markdown files that stay yours.
          </p>
          <button type="button" className="zn-onboard-cta" onClick={() => setStep('storage')}>
            Get started
          </button>
        </div>
      ) : (
        <div className="zn-onboard-page">
          <h1>Your notes live on this {deviceNoun}</h1>
          <p className="zn-onboard-tagline">
            Plain Markdown files, private to this device. Works fully offline.
          </p>
          <div className="zn-onboard-cards">
            <button type="button" className="zn-onboard-card" onClick={() => onDone('local')}>
              <span className="zn-onboard-card-title">
                Start writing
                <em>Ready</em>
              </span>
              <span className="zn-onboard-card-sub">
                You can also connect a self-hosted ZenNotes server later in Settings.
              </span>
            </button>
          </div>
          <p className="zn-onboard-foot">
            Notes are plain files on your device — never on our servers.
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * Runs before bootVault() on a true first run. Resolves once the storage
 * choice is made (the pref is set, so bootVault creates the vault in the
 * right tier), or immediately for returning/updating users.
 */
export async function maybeRunFirstRunOnboarding(): Promise<void> {
  if (localStorage.getItem(ONBOARDED_KEY)) return
  if (!(await isFirstRun())) return

  await new Promise<void>((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = ReactDOM.createRoot(host)
    root.render(
      <OnboardingOverlay
        onDone={(choice) => {
          setStoragePref(choice)
          localStorage.setItem(ONBOARDED_KEY, '1')
          localStorage.setItem(WELCOME_PENDING_KEY, '1')
          localStorage.setItem(FAB_HINT_KEY, 'pending')
          root.unmount()
          host.remove()
          resolve()
        }}
      />
    )
  })
}
