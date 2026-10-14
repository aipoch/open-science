'use strict'
/* eslint-disable @typescript-eslint/no-require-imports -- Source E2E preload, never a production endpoint. */
const root = process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT
// Other source journeys use their own storage roots and never install outcome faults.
if (
  !process.versions.electron &&
  root?.includes('open-science-electron-e2e-') &&
  root === process.env.OPEN_SCIENCE_CONFIG_ROOT &&
  root === process.env.OPEN_SCIENCE_STORAGE_ROOT
) {
  const fs = require('node:fs/promises')
  const path = require('node:path')
  const original = fs.rename
  fs.rename = async function (source, destination) {
    let input
    try {
      input = JSON.parse(
        await fs.readFile(path.join(root, 'e2e-session-outcome-fault.json'), 'utf8')
      )
    } catch (error) {
      if (error.code === 'ENOENT') return original.call(this, source, destination)
      throw error
    }
    for (const value of [input.projectId, input.sessionId]) {
      if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(value))
        throw new Error('Unsafe outcome fixture identity.')
    }
    const dataRoot = path.resolve(input.dataRoot)
    if (dataRoot !== path.resolve(root) && !dataRoot.startsWith(path.resolve(root) + path.sep))
      throw new Error('The Artifact root must belong to the isolated fixture.')
    let reject = false
    if (input.kind === 'artifact-publication') {
      for (const value of [input.artifactStorageSessionId, input.artifactRunId]) {
        if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(value))
          throw new Error('Unsafe outcome Artifact identity.')
      }
      reject =
        path.dirname(String(source)) ===
          path.join(
            dataRoot,
            'artifacts',
            input.projectId,
            input.artifactStorageSessionId,
            '.pending',
            input.artifactRunId
          ) &&
        path.dirname(path.dirname(String(destination))) ===
          path.join(dataRoot, 'artifacts', input.projectId, input.sessionId) &&
        path.basename(String(destination)) === path.basename(String(source))
    } else if (
      String(destination) ===
      path.join(root, 'sessions', input.projectId, `${input.sessionId}.json`)
    ) {
      const candidate = JSON.parse(await fs.readFile(source, 'utf8')).session
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
      } else if (input.kind === 'submission') {
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
      await fs.appendFile(path.join(root, 'e2e-session-outcome-hits'), `${process.pid}\n`)
      throw Object.assign(new Error(`Synthetic ${input.kind} write failure.`), { code: 'EIO' })
    }
    return original.call(this, source, destination)
  }
  require('node:module').syncBuiltinESMExports()
}
