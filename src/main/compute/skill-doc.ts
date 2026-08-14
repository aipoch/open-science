import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ComputeHost } from '../../shared/compute'

const COMPUTE_SKILL_ID = 'remote-compute-ssh'
const COMPUTE_SKILL_DIRECTORY = `os-${COMPUTE_SKILL_ID}`
const HOST_PROJECTION_START = '<!-- open-science:compute-hosts:start -->'
const HOST_PROJECTION_END = '<!-- open-science:compute-hosts:end -->'

const statusLabel = (host: ComputeHost): string =>
  host.probeResult === undefined
    ? 'not yet probed'
    : host.probeResult.ok
      ? 'connected'
      : 'probe failed'

const renderHostProjection = (hosts: readonly ComputeHost[]): string =>
  hosts.length === 0
    ? '  (no hosts registered yet)'
    : hosts
        .map(
          (host) =>
            `  - ${host.displayName} (provider_id: \`${host.providerId}\`, shape: ${host.shape}, status: ${statusLabel(host)})`
        )
        .join('\n')

const projectionPattern = new RegExp(
  `${HOST_PROJECTION_START}\\n[\\s\\S]*?${HOST_PROJECTION_END}`,
  'm'
)

const withHostProjection = (document: string, projection: string): string => {
  const markedProjection = `${HOST_PROJECTION_START}\n${projection}\n${HOST_PROJECTION_END}`
  if (projectionPattern.test(document)) {
    return document.replace(projectionPattern, markedProjection)
  }

  // Migrate a pre-marker bundled copy in place. This only changes the known Registered hosts section
  // of the SSH Compute Skill; other bundled guidance stays byte-for-byte intact.
  const registeredHosts = /^(## Registered hosts\n\n)[\s\S]*?(?=^## |\s*$)/m
  if (registeredHosts.test(document)) {
    return document.replace(registeredHosts, `$1${markedProjection}\n\n`)
  }

  return document
}

const projectComputeSkillDoc = (document: string, hosts: readonly ComputeHost[]): string =>
  withHostProjection(document, renderHostProjection(hosts))

const extractHostProjection = (document: string): string | undefined => {
  const match = projectionPattern.exec(document)
  if (!match) return undefined
  return match[0].slice(HOST_PROJECTION_START.length, -HOST_PROJECTION_END.length).trim()
}

// Applies the dynamic host data from an earlier canonical document to a freshly copied bundled one.
// Generic Skill materialization therefore refreshes shipped guidance without erasing runtime state.
const preserveComputeHostProjection = (document: string, priorDocument: string): string => {
  const projection = extractHostProjection(priorDocument)
  return projection === undefined ? document : withHostProjection(document, projection)
}

// Updates the application-managed canonical Skill in place. The generic materializer owns creation of
// the os- directory; a missing document means this framework has not been provisioned yet, so there
// is intentionally nothing to create or expose.
const syncComputeSkillDoc = async (
  skillsDir: string,
  hosts: readonly ComputeHost[]
): Promise<void> => {
  const directory = join(skillsDir, COMPUTE_SKILL_DIRECTORY)
  const file = join(directory, 'SKILL.md')
  let document: string
  try {
    document = await readFile(file, 'utf8')
  } catch {
    return
  }

  const updated = projectComputeSkillDoc(document, hosts)
  if (updated === document) return

  // Materialized Skills are normally read-only. Temporarily restore only this application-owned
  // document, then restore its prior protections once the host projection is durable.
  const [directoryMode, fileMode] = await Promise.all([
    stat(directory)
      .then((entry) => entry.mode & 0o777)
      .catch(() => undefined),
    stat(file)
      .then((entry) => entry.mode & 0o777)
      .catch(() => undefined)
  ])
  await chmod(directory, 0o755).catch(() => undefined)
  await chmod(file, 0o644).catch(() => undefined)
  try {
    await writeFile(file, updated, 'utf8')
  } finally {
    if (fileMode !== undefined) await chmod(file, fileMode).catch(() => undefined)
    if (directoryMode !== undefined) await chmod(directory, directoryMode).catch(() => undefined)
  }
}

const hasCanonicalComputeSkillDoc = async (skillsDir: string): Promise<boolean> =>
  readFile(join(skillsDir, COMPUTE_SKILL_DIRECTORY, 'SKILL.md'), 'utf8')
    .then(() => true)
    .catch(() => false)

export {
  COMPUTE_SKILL_DIRECTORY,
  COMPUTE_SKILL_ID,
  hasCanonicalComputeSkillDoc,
  projectComputeSkillDoc,
  preserveComputeHostProjection,
  syncComputeSkillDoc
}
