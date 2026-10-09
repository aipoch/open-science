import type { ElectronApplication } from 'playwright'
import type { ElectronApp } from './electron-app'
import type { PersistedChatSession } from '../../src/shared/session-persistence'

export async function assertStopWindowIsolation(app: ElectronApp): Promise<void> {
  if (process.env.OPEN_SCIENCE_E2E_NO_FOCUS_REQUIRED !== '1') return
  const application = (app as unknown as { application: ElectronApplication }).application
  const windows = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      id: window.id,
      focusable: window.isFocusable(),
      focused: window.isFocused(),
      visible: window.isVisible()
    }))
  )
  if (
    !windows.length ||
    windows.some(({ focusable, focused, visible }) => focusable || focused || visible)
  )
    throw new Error('Stop background windows must remain hidden, unfocusable and unfocused.')
}

// Hold the real admission write while Main owns the request. An outer IPC wrapper would
// pause before ownership exists and could only test a different cancellation race.
export async function holdStopAdmission(
  app: ElectronApp,
  input: { projectId: string; sessionId: string; prompt: string }
): Promise<{
  captured: () => Promise<{ promptMessageId: string; at: number } | undefined>
  release: () => Promise<void>
}> {
  const application = (app as unknown as { application: ElectronApplication }).application
  const key = '__openScienceStopAdmissionGate'
  await application.evaluate(
    (_electron, { input, key }) => {
      const fs = process.getBuiltinModule('node:fs/promises')!
      const path = process.getBuiltinModule('node:path')!
      const root = process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT
      if (
        !root ||
        root !== process.env.OPEN_SCIENCE_CONFIG_ROOT ||
        !root.includes('open-science-electron-e2e-')
      )
        throw new Error('Refusing a Stop gate outside isolated fixture storage.')
      if (![input.projectId, input.sessionId].every((id) => /^[a-zA-Z0-9_-]+$/u.test(id)))
        throw new Error('Unsafe Stop gate identity.')
      const sessionPath = path.join(root, 'sessions', input.projectId, input.sessionId + '.json')
      let release!: () => void
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      const state: {
        original: typeof fs.rename
        proxy: typeof fs.rename
        release: () => void
        captured?: { promptMessageId: string; at: number }
      } = { original: fs.rename, proxy: fs.rename, release }
      state.proxy = new Proxy(state.original, {
        apply: async (original, receiver, args: Parameters<typeof fs.rename>) => {
          if (!state.captured && String(args[1]) === sessionPath) {
            const candidate = JSON.parse(await fs.readFile(args[0], 'utf8'))
              .session as PersistedChatSession
            const message = (candidate.conversationGraph?.messages ?? candidate.messages).find(
              ({ role, content }) => role === 'user' && content === input.prompt
            )
            if (
              message &&
              candidate.runtimeSessionAdmissions?.some(
                ({ promptMessageId }) => promptMessageId === message.id
              )
            ) {
              state.captured = { promptMessageId: message.id, at: Date.now() }
              await wait
            }
          }
          return Reflect.apply(original, receiver, args)
        }
      })
      Reflect.set(globalThis, key, state)
      fs.rename = state.proxy
    },
    { input, key }
  )
  return {
    captured: () =>
      application.evaluate((_electron, key) => Reflect.get(globalThis, key)?.captured, key),
    release: async () => {
      await application.evaluate((_electron, key) => {
        const state = Reflect.get(globalThis, key)
        if (!state) return
        const fs = process.getBuiltinModule('node:fs/promises')!
        if (fs.rename !== state.proxy) throw new Error('Stop gate lost fs.rename ownership.')
        fs.rename = state.original
        state.release()
        Reflect.deleteProperty(globalThis, key)
      }, key)
    }
  }
}
