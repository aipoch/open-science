import type { App, Dialog } from 'electron'

// Serialized by Playwright and run inside Electron, so keep runtime dependencies inside the body.
export const captureNativeQuitDialog = async ({
  app,
  dialog
}: {
  app: App
  dialog: Dialog
}): Promise<{
  buttons: string[]
  detail: string
  includesRendererCatalog: boolean
  message: string
} | null> => {
  const { readFileSync, realpathSync } = process.getBuiltinModule('node:fs')
  const { createRequire } = process.getBuiltinModule('node:module')
  const { join, sep } = process.getBuiltinModule('node:path')
  const appRoot = app.getAppPath()
  const mainRoot = realpathSync(join(appRoot, 'out', 'main'))
  const requireFromApp = createRequire(join(appRoot, 'package.json'))
  // Inspect already-loaded main modules by public export, without loading extra chunks or assuming
  // Rollup emits a separate catalog file (or gives any chunk a particular name).
  const loadedExport = (name: string): Record<string, unknown> => {
    for (const module of Object.values(requireFromApp.cache)) {
      if (typeof module?.filename !== 'string' || !module.filename.startsWith(mainRoot + sep))
        continue
      const exports = module.exports as Record<string, unknown>
      if (typeof exports?.[name] === 'function') return exports
    }
    throw new Error(`Built Electron export ${name} is not loaded.`)
  }
  const ownerModule = loadedExport('LocalePreferenceOwner') as {
    LocalePreferenceOwner: new (
      systemLanguageTags: readonly string[],
      repository: { setLocalePreference: (locale: string) => Promise<void> },
      initialPreference: string
    ) => {
      t: (key: string, options?: Record<string, string | number>) => string
    }
  }
  const close = loadedExport('createElectronCloseConfirm') as {
    createElectronCloseConfirm: (
      getWindow: () => undefined,
      preferences: {
        get: () => Promise<undefined>
        set: () => Promise<void>
      },
      translate: (key: string, options?: Record<string, string | number>) => string
    ) => (
      variant: 'quit',
      sessions: Array<{ projectId: string; sessionId: string; kind: 'agent' }>
    ) => Promise<string>
  }
  const storageRoot = process.env.OPEN_SCIENCE_STORAGE_ROOT
  if (!storageRoot) throw new Error('Electron E2E storage root is unavailable.')
  const settings = JSON.parse(readFileSync(join(storageRoot, 'settings.json'), 'utf8')) as {
    localePreference?: string
  }
  if (!settings.localePreference || settings.localePreference === 'system') {
    return null
  }
  const localeOwner = new ownerModule.LocalePreferenceOwner(
    ['en-US'],
    { setLocalePreference: async () => undefined },
    settings.localePreference
  )
  let captured: { buttons?: string[]; detail?: string; message?: string } | undefined
  const descriptor = Object.getOwnPropertyDescriptor(dialog, 'showMessageBox')
  Object.defineProperty(dialog, 'showMessageBox', {
    configurable: true,
    value: async (...args: unknown[]) => {
      captured = args.at(-1) as typeof captured
      return { checkboxChecked: false, response: 0 }
    }
  })

  try {
    const confirm = close.createElectronCloseConfirm(
      () => undefined,
      { get: async () => undefined, set: async () => undefined },
      (key, options) => localeOwner.t(key, options)
    )
    await confirm('quit', [{ projectId: 'e2e', sessionId: 'e2e', kind: 'agent' }])
  } finally {
    if (descriptor) Object.defineProperty(dialog, 'showMessageBox', descriptor)
    else Reflect.deleteProperty(dialog, 'showMessageBox')
  }

  if (!captured?.buttons || !captured.detail || !captured.message) {
    throw new Error('Native quit dialog options were not captured.')
  }
  return {
    buttons: captured.buttons,
    detail: captured.detail,
    includesRendererCatalog: ['This directory does not exist or is not a directory'].some(
      (key) => localeOwner.t(key) !== key
    ),
    message: captured.message
  }
}
