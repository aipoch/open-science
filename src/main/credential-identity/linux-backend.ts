import { CredentialIdentityError } from './selection'

export type LinuxKWalletBackend = 'kwallet' | 'kwallet5' | 'kwallet6'
export type LinuxCredentialBackend = 'gnome_libsecret' | LinuxKWalletBackend

// Mirror Chromium's ordered GetDesktopEnvironment/SelectBackend rules. Service availability
// must never switch the backend: a healthy second store need not contain the original key.
export const selectLinuxCredentialBackend = (passwordStore = ''): LinuxCredentialBackend => {
  if (passwordStore === 'gnome-libsecret') return 'gnome_libsecret'
  if (passwordStore === 'kwallet' || passwordStore === 'kwallet5' || passwordStore === 'kwallet6')
    return passwordStore
  if (passwordStore) throw new CredentialIdentityError(`linux-backend-unsupported:${passwordStore}`)
  const desktops = (process.env.XDG_CURRENT_DESKTOP ?? '').split(':').map((name) => name.trim())
  const secretService = new Set([
    'GNOME',
    'Unity',
    'X-Cinnamon',
    'Deepin',
    'Pantheon',
    'UKUI',
    'XFCE',
    'COSMIC'
  ])
  for (const desktop of desktops) {
    if (desktop === 'KDE') {
      if (process.env.KDE_SESSION_VERSION === '6') return 'kwallet6'
      if (process.env.KDE_SESSION_VERSION === '5') return 'kwallet5'
      return 'kwallet'
    }
    if (desktop === 'LXQt') throw new CredentialIdentityError('linux-backend-unsupported:LXQt')
    if (secretService.has(desktop)) return 'gnome_libsecret'
  }
  const session = process.env.DESKTOP_SESSION ?? ''
  if (['deepin', 'gnome', 'mate', 'ukui', 'xubuntu'].includes(session) || session.includes('xfce'))
    return 'gnome_libsecret'
  if (['kde4', 'kde-plasma'].includes(session)) return 'kwallet'
  if (session === 'kde') {
    if (process.env.KDE_SESSION_VERSION !== undefined) return 'kwallet'
    throw new CredentialIdentityError('linux-backend-unsupported:KDE3')
  }
  if (process.env.GNOME_DESKTOP_SESSION_ID !== undefined) return 'gnome_libsecret'
  if (process.env.KDE_FULL_SESSION !== undefined && process.env.KDE_SESSION_VERSION !== undefined)
    return 'kwallet'
  throw new CredentialIdentityError('linux-backend-unsupported:desktop-selection')
}
