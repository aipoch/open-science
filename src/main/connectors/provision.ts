import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ALL_CONNECTOR_IDS } from './registry'
import { renderSkillDoc, renderCustomSkillDoc } from './skill-doc'
import type { CustomSkillDocTool } from './skill-doc'
import type { StoredCustomMcpServer } from '../settings/types'
import {
  customConnectorSlug,
  customConnectorSlugFromSkillName
} from '../../shared/custom-connector'
import { parseFrontmatter } from '../skills/frontmatter'

// Whether an `mcp-<x>` directory's suffix names a bundled connector — CASE-INSENSITIVELY. This
// matters for cleanup ownership: an older version could have left a case-variant dir like
// `mcp-Chemistry` (from a custom server literally named "Chemistry"), and on a case-preserving
// filesystem (APFS/NTFS) the built-in sync then writes mcp-chemistry's doc INTO that same directory.
// A case-sensitive check would treat `mcp-Chemistry` as a stray custom dir and delete the built-in
// doc with it, so ownership must fold case.
const namesBundledConnector = (dirId: string): boolean =>
  ALL_CONNECTOR_IDS.includes(dirId.toLowerCase())

// Skill identities are lowercase ASCII, but APFS and NTFS commonly resolve paths without regard
// to case. If an externally-owned case variant already exists, writing the canonical name would
// overwrite that same directory on those filesystems. Detect the alias from the directory listing
// so every platform preserves the same ownership boundary.
const findCaseFoldedAlias = async (
  parentDir: string,
  canonicalName: string
): Promise<string | undefined> => {
  const foldedCanonicalName = canonicalName.toLowerCase()
  return (await readdir(parentDir).catch(() => [] as string[])).find(
    (entry) => entry !== canonicalName && entry.toLowerCase() === foldedCanonicalName
  )
}

// Writes skills/mcp-<connector>/SKILL.md for enabled connectors; removes the directory for
// disabled ones. Claude Code discovers skills as `<name>/SKILL.md` directories, not flat files.
// Custom-server directories (see syncCustomServerSkillDocs below) live in the same skills dir;
// cleanup here only ever touches names that are known bundled connector ids, so the two sync
// passes can never delete each other's output.
export async function syncConnectorSkillDocs(
  skillsDir: string,
  enabledIds: string[]
): Promise<void> {
  // A first-run pre-enabled connector may sync before the skills dir has ever been created.
  await mkdir(skillsDir, { recursive: true })
  const enabled = new Set(enabledIds.filter((id) => ALL_CONNECTOR_IDS.includes(id)))
  for (const id of enabled) {
    const dir = join(skillsDir, `mcp-${id}`)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), renderSkillDoc(id), 'utf8')
  }
  const existing = await readdir(skillsDir).catch(() => [] as string[])
  for (const entry of existing) {
    const m = /^mcp-(.+)$/.exec(entry)
    if (!m || !namesBundledConnector(m[1])) continue // not a bundled-connector dir; leave it alone
    const canonicalId = m[1].toLowerCase()

    if (!enabled.has(canonicalId)) {
      // Disabled connector — remove its dir in whatever case it appears.
      await rm(join(skillsDir, entry), { recursive: true, force: true })
      continue
    }

    // Enabled connector: keep exactly one directory, the canonical lowercase `mcp-<id>`. A remaining
    // case-variant (e.g. mcp-Chemistry left by an old version) is stale and removed — but only when it
    // is a DISTINCT directory from the canonical one. On a case-insensitive filesystem the variant IS
    // the canonical dir (same dev+ino, holding the freshly-written built-in doc), so it is kept.
    if (entry !== `mcp-${canonicalId}`) {
      const [canonical, variant] = await Promise.all([
        stat(join(skillsDir, `mcp-${canonicalId}`)).catch(() => null),
        stat(join(skillsDir, entry)).catch(() => null)
      ])
      const distinct =
        canonical && variant && (canonical.dev !== variant.dev || canonical.ino !== variant.ino)
      if (distinct) await rm(join(skillsDir, entry), { recursive: true, force: true })
    }
  }
}

export type CustomServerListTools = (server: StoredCustomMcpServer) => Promise<CustomSkillDocTool[]>

export type CustomServerSkillSyncResult = {
  materializedSlugs: string[]
  failures: Array<{ server: StoredCustomMcpServer; error: unknown }>
}

export type MaterializedCustomSkillDocSyncResult = {
  materializedSkillNames: string[]
  failures: Array<{ skillName: string; error: unknown }>
}

const isSafeCustomServerSlug = (slug: string): boolean =>
  /^[a-z0-9-]+$/.test(slug) && !ALL_CONNECTOR_IDS.includes(slug)

// Writes skills/mcp-<slug>/SKILL.md for enabled custom MCP servers, sourced from the server's
// live listTools() schema rather than a bundled descriptor table (§3.4). Cleanup mirrors
// syncConnectorSkillDocs: it only removes ids that are NOT known bundled connector ids, so
// the two sync passes never delete each other's directories even when run against the same dir.
export async function syncCustomServerSkillDocs(
  skillsDir: string,
  servers: StoredCustomMcpServer[],
  listTools: CustomServerListTools
): Promise<CustomServerSkillSyncResult> {
  await mkdir(skillsDir, { recursive: true })
  const safeServers = servers
    .map((server) => ({ server, slug: customConnectorSlug(server) }))
    .filter(({ slug }) => isSafeCustomServerSlug(slug))
  const materializedSlugs: string[] = []
  const failures: CustomServerSkillSyncResult['failures'] = []
  for (const { server, slug } of safeServers) {
    const skillName = `mcp-${slug}`
    const dir = join(skillsDir, skillName)
    const caseFoldedAlias = await findCaseFoldedAlias(skillsDir, skillName)
    if (caseFoldedAlias) {
      failures.push({
        server,
        error: new Error(
          `custom Connector Skill ${skillName} conflicts with existing case-variant ${caseFoldedAlias}`
        )
      })
      continue
    }
    let tools: CustomSkillDocTool[]
    try {
      tools = await listTools(server)
    } catch (error) {
      failures.push({ server, error })
      // A previously healthy Connector may have left a now-stale Skill behind. Keeping it would
      // advertise tools that this startup could not actually discover or call.
      await rm(dir, { recursive: true, force: true })
      continue
    }
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), renderCustomSkillDoc(server, tools), 'utf8')
    materializedSlugs.push(slug)
  }
  const enabledSlugs = new Set(materializedSlugs)
  const existing = await readdir(skillsDir).catch(() => [] as string[])
  for (const entry of existing) {
    const slug = customConnectorSlugFromSkillName(entry)
    // A bundled-connector dir (case-insensitive) belongs to syncConnectorSkillDocs — never delete it
    // here, even a case-variant like mcp-Chemistry that the built-in sync has written its doc into.
    // Invalid/non-canonical names are also unowned and must be preserved.
    if (!slug || namesBundledConnector(slug)) continue
    if (!enabledSlugs.has(slug)) {
      await rm(join(skillsDir, entry), { recursive: true, force: true })
    }
  }
  return { materializedSlugs, failures }
}

// Copies only successfully generated custom Connector docs from the canonical app-owned Claude
// Skill root into an isolated ACP runtime root. The projection-provided names are the authorization
// boundary: stale custom dirs are removed, while bundled Connector dirs remain owned by
// syncConnectorSkillDocs. Reading and writing the exact SKILL.md avoids copying arbitrary trees.
export async function syncMaterializedCustomServerSkillDocs(
  sourceSkillsDir: string,
  targetSkillsDir: string,
  skillNames: readonly string[]
): Promise<MaterializedCustomSkillDocSyncResult> {
  await mkdir(targetSkillsDir, { recursive: true })
  const requested = [
    ...new Set(
      skillNames.filter((skillName) => {
        const slug = customConnectorSlugFromSkillName(skillName)
        return slug !== undefined && !namesBundledConnector(slug)
      })
    )
  ]
  const materializedSkillNames: string[] = []
  const failures: MaterializedCustomSkillDocSyncResult['failures'] = []

  for (const skillName of requested) {
    const sourceFile = join(sourceSkillsDir, skillName, 'SKILL.md')
    const targetDir = join(targetSkillsDir, skillName)
    const caseFoldedAlias = await findCaseFoldedAlias(targetSkillsDir, skillName)
    if (caseFoldedAlias) {
      failures.push({
        skillName,
        error: new Error(
          `custom Connector Skill ${skillName} conflicts with existing case-variant ${caseFoldedAlias}`
        )
      })
      continue
    }
    try {
      const sourceMetadata = await lstat(sourceFile)
      if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
        throw new Error('canonical custom Connector Skill doc is not a regular file')
      }
      const contents = await readFile(sourceFile, 'utf8')
      const { fields } = parseFrontmatter(contents)
      if (
        fields.name !== skillName ||
        fields.source !== 'connector' ||
        !fields.description?.trim()
      ) {
        throw new Error('canonical custom Connector Skill doc has invalid frontmatter')
      }

      // Never write through a target symlink or a non-directory left by external modification.
      const targetMetadata = await lstat(targetDir).catch(() => undefined)
      if (targetMetadata && (!targetMetadata.isDirectory() || targetMetadata.isSymbolicLink())) {
        await rm(targetDir, { recursive: true, force: true })
      }
      await mkdir(targetDir, { recursive: true })
      const targetFile = join(targetDir, 'SKILL.md')
      const targetFileMetadata = await lstat(targetFile).catch(() => undefined)
      if (
        targetFileMetadata &&
        (!targetFileMetadata.isFile() || targetFileMetadata.isSymbolicLink())
      ) {
        await rm(targetFile, { recursive: true, force: true })
      }
      await writeFile(targetFile, contents, 'utf8')
      materializedSkillNames.push(skillName)
    } catch (error) {
      failures.push({ skillName, error })
      await rm(targetDir, { recursive: true, force: true })
    }
  }

  const materialized = new Set(materializedSkillNames)
  for (const entry of await readdir(targetSkillsDir).catch(() => [] as string[])) {
    const slug = customConnectorSlugFromSkillName(entry)
    if (!slug || namesBundledConnector(slug)) continue
    if (!materialized.has(entry)) {
      await rm(join(targetSkillsDir, entry), { recursive: true, force: true })
    }
  }

  return { materializedSkillNames, failures }
}
