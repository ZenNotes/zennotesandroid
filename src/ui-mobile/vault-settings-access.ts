export type VaultSettingsAccess = 'quick-switch' | 'manage-button'

/** Phone settings have room for the full switcher; tablet settings retain the
 * compact entry point into the same canonical vault manager. */
export function vaultSettingsAccessForLayout(isPhoneLayout: boolean): VaultSettingsAccess {
  return isPhoneLayout ? 'quick-switch' : 'manage-button'
}
