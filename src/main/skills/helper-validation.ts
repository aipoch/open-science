import { existsSync } from 'node:fs'
import type { SkillHelperValidator } from '@aipoch/skills'
import { validateNotebookHelperExports, type PythonCommand } from '@aipoch/environment'
import {
  condaActivatedPath,
  DEFAULT_PY_ENV,
  envPrefix,
  pythonBin,
  runtimeRoot
} from '@aipoch/environment'

const managedPythonValidation = (
  storageRoot: string | undefined
): { python: PythonCommand; env: NodeJS.ProcessEnv } | undefined => {
  if (!storageRoot) return undefined
  const prefix = envPrefix(runtimeRoot(storageRoot), DEFAULT_PY_ENV)
  const command = pythonBin(prefix)
  if (!existsSync(command)) return undefined
  const env: NodeJS.ProcessEnv = {
    PATH: condaActivatedPath(prefix, process.env.PATH),
    ...(process.platform === 'win32'
      ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
      : {})
  }
  return {
    python: { command, baseArgs: [] },
    env
  }
}

export const validateSkillHelper: SkillHelperValidator = (id, source, exports, storageRoot) =>
  validateNotebookHelperExports(id, source, exports, managedPythonValidation(storageRoot) ?? {})
