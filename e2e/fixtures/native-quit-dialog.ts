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
  void app
  const fixture = (
    globalThis as typeof globalThis & {
      __openScienceNativeQuitFixture?: {
        confirm: (
          variant: 'quit',
          sessions: { projectId: string; sessionId: string; kind: 'agent' }[]
        ) => Promise<string>
        translate: (key: string) => string
      }
    }
  ).__openScienceNativeQuitFixture
  if (!fixture) throw new Error('Built native quit confirmation is not captured.')
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
    await fixture.confirm('quit', [{ projectId: 'e2e', sessionId: 'e2e', kind: 'agent' }])
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
      (key) => fixture.translate(key) !== key
    ),
    message: captured.message
  }
}
