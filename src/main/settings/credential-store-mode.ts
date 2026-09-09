// Selected once at application startup, never inferred from vault availability or persisted secrets.
let credentialStore: 'os' | 'file' = 'os'

export const getCredentialStore = (): 'os' | 'file' => credentialStore

export const configureCredentialStore = (
  argv: readonly string[],
  platform: NodeJS.Platform,
  headless: boolean
): void => {
  const flags = argv.filter((arg) => arg.startsWith('--credential-store'))
  if (flags.length === 0) {
    credentialStore = 'os'
    return
  }
  if (
    flags.length !== 1 ||
    !['--credential-store=os', '--credential-store=file'].includes(flags[0])
  ) {
    throw new Error('Use --credential-store=os or --credential-store=file.')
  }
  if (flags[0] === '--credential-store=file' && (platform !== 'linux' || !headless)) {
    throw new Error('File credential storage is supported only by the Linux headless backend.')
  }
  credentialStore = flags[0] === '--credential-store=file' ? 'file' : 'os'
}
