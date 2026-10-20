import { runArchiveTask } from './worker-runner'
/// <reference types="electron-vite/node" />
import createArchiveWorker from './worker?nodeWorker'
import type { SkillDiscovery } from '@aipoch/skills/sources'
import { validateSpecialistZip } from '@aipoch/specialists/node'
import { parseSkillDocument } from '@aipoch/skills/document'
import type { Zippable } from 'fflate'

export const zipSettingsFiles = (files: Zippable): Promise<Uint8Array> =>
  runArchiveTask(createArchiveWorker, { kind: 'zip', files })
export const zipSpecialistFiles = (files: Record<string, Uint8Array>): Promise<Uint8Array> =>
  runArchiveTask(createArchiveWorker, { kind: 'specialist-export', files })
export const discoverSkillArchive = async (bytes: Buffer): Promise<SkillDiscovery> => {
  const result = await runArchiveTask<SkillDiscovery>(createArchiveWorker, {
    kind: 'discover',
    bytes
  })
  for (const root of result.roots)
    for (const file of root.files) file.content = Buffer.from(file.content)
  return result
}
export const validateSpecialistArchive = (
  ...[bytes, catalog, parser = parseSkillDocument]: Parameters<typeof validateSpecialistZip>
): Promise<ReturnType<typeof validateSpecialistZip>> =>
  // Callbacks cannot be cloned into a Worker. Preserve custom parser behavior for package hosts;
  // the desktop's standard parser is installed inside the worker itself.
  parser === parseSkillDocument
    ? runArchiveTask(createArchiveWorker, { kind: 'specialist', bytes, catalog })
    : Promise.resolve(validateSpecialistZip(bytes, catalog, parser))
