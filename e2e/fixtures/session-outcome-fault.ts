import type { ElectronApplication, Page } from 'playwright'
import type { PersistedChatSession } from '../../src/shared/session-persistence'
import type { AcpPromptRequest } from '../../src/shared/acp'

type NativeApp = { readonly page: Page }
type SessionIdentity = { projectId: string; sessionId: string }
type FaultRequest = SessionIdentity &
  (
    | { kind: 'terminal'; promptMessageId: string; executionId: string; startedAt: number }
    | { kind: 'submission'; prompt: string }
    | { kind: 'artifact-publication'; artifactRunId: string; artifactStorageSessionId: string }
  )
type FaultState = {
  original: typeof import('node:fs/promises').rename
  proxy: typeof import('node:fs/promises').rename
  hits: number
}

const FAULT_KEY = '__openScienceSessionOutcomeFault'
const nativeApplication = (app: NativeApp): ElectronApplication => {
  // The existing diagnostic fixture uses this same private native handle. Keep it contained here.
  const application = (app as unknown as { application?: ElectronApplication }).application
  if (!application) throw new Error('The Electron fixture native application is unavailable.')
  return application
}

export const readRawOutcomeSession = async (
  app: NativeApp,
  identity: SessionIdentity
): Promise<PersistedChatSession> =>
  nativeApplication(app).evaluate(async (_electron, input) => {
    const fs = process.getBuiltinModule('node:fs/promises')!
    const path = process.getBuiltinModule('node:path')!
    const root = process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT
    if (!root || root !== process.env.OPEN_SCIENCE_CONFIG_ROOT)
      throw new Error('The outcome fixture requires isolated storage.')
    return JSON.parse(
      await fs.readFile(
        path.join(root, 'sessions', input.projectId, `${input.sessionId}.json`),
        'utf8'
      )
    ).session as PersistedChatSession
  }, identity)

export const readOutcomeArtifactRun = async (
  app: NativeApp,
  identity: SessionIdentity
): Promise<{ artifactRunId: string; artifactStorageSessionId: string }> => {
  const session = await readRawOutcomeSession(app, identity)
  const executionId = session.runtimeSessionAdmissions?.findLast(
    (admission) => admission.promptMessageId === session.activeRun?.promptMessageId
  )?.executionId
  if (!executionId) throw new Error('The Artifact execution was not admitted.')
  const dataRoot = await app.page.evaluate(
    async () => (await window.api.storage.getInfo()).dataRoot
  )
  return nativeApplication(app).evaluate(
    async (_electron, input) => {
      const fs = process.getBuiltinModule('node:fs/promises')!
      const path = process.getBuiltinModule('node:path')!
      const root = process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT
      if (!root || root !== process.env.OPEN_SCIENCE_CONFIG_ROOT)
        throw new Error('The outcome fixture requires isolated storage.')
      if (
        path.resolve(input.dataRoot) !== path.resolve(root) &&
        !path.resolve(input.dataRoot).startsWith(path.resolve(root) + path.sep)
      )
        throw new Error('The Artifact root must belong to the isolated fixture.')
      const projectRoot = path.join(input.dataRoot, 'artifacts', input.projectId)
      for (const entry of await fs.readdir(projectRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const sessionRoot = path.join(projectRoot, entry.name)
        const candidates = [path.join(sessionRoot, '.pending', 'current-run.json')]
        const handoffs = path.join(sessionRoot, '.execution-handoffs')
        try {
          for (const filename of await fs.readdir(handoffs))
            if (filename.endsWith('.json')) candidates.push(path.join(handoffs, filename))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        for (const candidate of candidates) {
          let handoff: Record<string, unknown>
          try {
            handoff = JSON.parse(await fs.readFile(candidate, 'utf8'))
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
            throw error
          }
          if (handoff.appSessionId !== input.sessionId || handoff.executionId !== input.executionId)
            continue
          if (
            typeof handoff.artifactRunId !== 'string' ||
            typeof handoff.artifactStorageSessionId !== 'string'
          )
            throw new Error('The Artifact handoff lacks its exact storage scope.')
          return {
            artifactRunId: handoff.artifactRunId,
            artifactStorageSessionId: handoff.artifactStorageSessionId
          }
        }
      }
      throw new Error('The admitted Artifact execution handoff was not found.')
    },
    { ...identity, dataRoot, executionId }
  )
}

export const releaseOutcomeArtifact = async (app: NativeApp, sessionId: string): Promise<void> => {
  await nativeApplication(app).evaluate(async (_electron, id) => {
    const fs = process.getBuiltinModule('node:fs/promises')!
    const path = process.getBuiltinModule('node:path')!
    const root = process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT
    const capture = process.env.OPEN_SCIENCE_E2E_HANDOFF_CAPTURE_ROOT
    if (!root || capture !== path.join(root, 'e2e-handoff-captures'))
      throw new Error('The outcome gate requires isolated storage.')
    await fs.mkdir(capture, { recursive: true })
    await fs.writeFile(
      path.join(capture, 'turn-outcome-artifact-release.json'),
      JSON.stringify({ sessionId: id })
    )
  }, sessionId)
}

// Replace only fs.rename in this isolated Main process. Candidate JSON and exact run identity
// distinguish terminal persistence from admission, streaming and unrelated preference writes.
export const installSessionOutcomeFault = async (
  app: NativeApp,
  request: FaultRequest
): Promise<{ hits: () => Promise<number>; restore: () => Promise<void> }> => {
  const application = nativeApplication(app)
  const dataRoot = await app.page.evaluate(
    async () => (await window.api.storage.getInfo()).dataRoot
  )
  await application.evaluate(
    async (_electron, { input, key, dataRoot }) => {
      const fs = process.getBuiltinModule('node:fs/promises')!
      const path = process.getBuiltinModule('node:path')!
      const root = process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT
      if (
        !root ||
        root !== process.env.OPEN_SCIENCE_CONFIG_ROOT ||
        root !== process.env.OPEN_SCIENCE_STORAGE_ROOT ||
        !root.includes('open-science-electron-e2e-')
      )
        throw new Error('Refusing an outcome fault outside fixture-owned storage.')
      for (const value of [input.projectId, input.sessionId])
        if (!/^[a-zA-Z0-9_-]+$/u.test(value)) throw new Error('Unsafe outcome fixture identity.')
      const registry = globalThis as unknown as Record<string, FaultState | undefined>
      if (registry[key]) throw new Error('An outcome fault is already installed.')
      const sessionPath = path.join(root, 'sessions', input.projectId, `${input.sessionId}.json`)
      if (
        path.resolve(dataRoot) !== path.resolve(root) &&
        !path.resolve(dataRoot).startsWith(path.resolve(root) + path.sep)
      )
        throw new Error('The Artifact root must belong to the isolated fixture.')
      const storageSessionId =
        input.kind === 'artifact-publication' ? input.artifactStorageSessionId : input.sessionId
      if (!/^[a-zA-Z0-9_-]+$/u.test(storageSessionId))
        throw new Error('Unsafe Artifact storage scope.')
      const artifactRoot = path.join(dataRoot, 'artifacts', input.projectId, storageSessionId)
      if (input.kind === 'artifact-publication' && !/^[a-zA-Z0-9_-]+$/u.test(input.artifactRunId))
        throw new Error('Unsafe outcome Artifact run identity.')
      const state: FaultState = { original: fs.rename, proxy: fs.rename, hits: 0 }
      state.proxy = new Proxy(state.original, {
        apply: async (original, receiver, args: Parameters<typeof fs.rename>) => {
          const [source, destination] = args
          let reject = false
          if (input.kind === 'artifact-publication') {
            reject =
              path.dirname(String(source)) ===
                path.join(artifactRoot, '.pending', input.artifactRunId) &&
              path.dirname(path.dirname(String(destination))) ===
                path.join(dataRoot, 'artifacts', input.projectId, input.sessionId) &&
              path.basename(String(destination)) === path.basename(String(source))
          } else if (String(destination) === sessionPath) {
            const candidate = JSON.parse(await fs.readFile(source, 'utf8'))
              .session as PersistedChatSession
            if (input.kind === 'terminal') {
              reject =
                !candidate.activeRun &&
                Boolean(
                  candidate.runtimeSessionAdmissions?.some(
                    (admission) =>
                      admission.executionId === input.executionId &&
                      admission.promptMessageId === input.promptMessageId
                  )
                ) &&
                candidate.runtimeTranscriptLastRun?.promptMessageId === input.promptMessageId &&
                candidate.runtimeTranscriptLastRun?.startedAt === input.startedAt
            } else {
              const prompt = (candidate.conversationGraph?.messages ?? candidate.messages).find(
                (message) => message.role === 'user' && message.content === input.prompt
              )
              reject = Boolean(
                prompt &&
                !candidate.runtimeSessionAdmissions?.some(
                  (admission) => admission.promptMessageId === prompt.id
                )
              )
            }
          }
          if (reject) {
            state.hits++
            throw Object.assign(new Error(`Synthetic ${input.kind} write failure.`), {
              code: 'EIO'
            })
          }
          return Reflect.apply(original, receiver, args)
        }
      })
      registry[key] = state
      fs.rename = state.proxy
    },
    { input: request, key: FAULT_KEY, dataRoot }
  )
  return {
    hits: () =>
      application.evaluate(
        (_electron, key) =>
          (globalThis as unknown as Record<string, FaultState | undefined>)[key]?.hits ?? 0,
        FAULT_KEY
      ),
    restore: async () => {
      await application.evaluate((_electron, key) => {
        const fs = process.getBuiltinModule('node:fs/promises')!
        const registry = globalThis as unknown as Record<string, FaultState | undefined>
        const state = registry[key]
        if (!state) return
        if (fs.rename !== state.proxy)
          throw new Error('The outcome fault lost ownership of fs.rename.')
        fs.rename = state.original
        delete registry[key]
      }, FAULT_KEY)
    }
  }
}

// Pause one real IPC request immediately before Main admission, retaining the actual prepared
// Session on disk. The crash journey kills this isolated process; no Session JSON is fabricated.
export const holdOutcomeAdmission = async (
  app: NativeApp,
  prompt: string
): Promise<{
  captured: () => Promise<{ sessionId: string; promptMessageId: string } | undefined>
  restore: () => Promise<void>
}> => {
  const application = nativeApplication(app)
  const child = application.process()
  const key = '__openScienceOutcomeAdmissionGate'
  await application.evaluate(
    ({ ipcMain }, { prompt, key }) => {
      const root = process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT
      if (
        !root ||
        root !== process.env.OPEN_SCIENCE_CONFIG_ROOT ||
        !root.includes('open-science-electron-e2e-')
      )
        throw new Error('Refusing an admission gate outside fixture-owned storage.')
      type Handler = (...args: unknown[]) => Promise<unknown>
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, Handler>
      const original = handlers.get('acp:send-prompt')
      if (!original) throw new Error('The real prompt command handler is unavailable.')
      let release!: () => void
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const state: {
        original: Handler
        release: () => void
        captured?: { sessionId: string; promptMessageId: string }
      } = { original, release }
      Object.assign(globalThis, { [key]: state })
      handlers.set('acp:send-prompt', async (...args) => {
        const request = args[1] as AcpPromptRequest
        const promptMessageId = request.provenanceContext?.promptMessageId
        if (request.text === prompt && request.sessionId && promptMessageId) {
          state.captured = {
            sessionId: request.sessionId,
            promptMessageId
          }
          await blocked
        }
        return original(...args)
      })
    },
    { prompt, key }
  )
  return {
    captured: () =>
      application.evaluate((_electron, key) => Reflect.get(globalThis, key)?.captured, key),
    restore: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      await application.evaluate(({ ipcMain }, key) => {
        const state = Reflect.get(globalThis, key)
        if (!state) return
        Reflect.get(ipcMain, '_invokeHandlers').set('acp:send-prompt', state.original)
        state.release()
        Reflect.deleteProperty(globalThis, key)
      }, key)
    }
  }
}
