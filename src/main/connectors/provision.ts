import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ALL_CONNECTOR_IDS } from './registry'
import { renderSkillDoc, renderCustomSkillDoc } from './skill-doc'
import type { CustomSkillDocTool } from './skill-doc'
import type { StoredCustomMcpServer } from '../settings/types'

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
    if (m && ALL_CONNECTOR_IDS.includes(m[1]) && !enabled.has(m[1])) {
      await rm(join(skillsDir, entry), { recursive: true, force: true })
    }
  }
}

export type CustomServerListTools = (server: StoredCustomMcpServer) => Promise<CustomSkillDocTool[]>

// A custom server's skill dir is keyed on its immutable UUID id, NEVER its user-facing name. The
// name is only validated non-empty upstream, so a name like `../evil` would let SKILL.md escape
// skillsDir, and a name equal to a bundled connector id (e.g. `chemistry`) would clobber the
// built-in mcp-chemistry doc. The id is a randomUUID (safe token, never a bundled id); this guard
// additionally rejects any id that isn't a safe path segment — defense against a tampered
// settings.json — so a hand-crafted id can't reintroduce traversal or a bundled-id collision.
const isSafeCustomServerId = (id: string): boolean =>
  /^[A-Za-z0-9_-]+$/.test(id) && !ALL_CONNECTOR_IDS.includes(id)

// Writes skills/mcp-<id>/SKILL.md for enabled custom MCP servers, sourced from the server's
// live listTools() schema rather than a bundled descriptor table (§3.4). Cleanup mirrors
// syncConnectorSkillDocs: it only removes ids that are NOT known bundled connector ids, so
// the two sync passes never delete each other's directories even when run against the same dir.
export async function syncCustomServerSkillDocs(
  skillsDir: string,
  servers: StoredCustomMcpServer[],
  listTools: CustomServerListTools
): Promise<void> {
  await mkdir(skillsDir, { recursive: true })
  const safeServers = servers.filter((s) => isSafeCustomServerId(s.id))
  const enabledIds = new Set(safeServers.map((s) => s.id))
  for (const server of safeServers) {
    const tools = await listTools(server)
    const dir = join(skillsDir, `mcp-${server.id}`)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), renderCustomSkillDoc(server, tools), 'utf8')
  }
  const existing = await readdir(skillsDir).catch(() => [] as string[])
  for (const entry of existing) {
    const m = /^mcp-(.+)$/.exec(entry)
    if (!m || ALL_CONNECTOR_IDS.includes(m[1])) continue // owned by syncConnectorSkillDocs
    if (!enabledIds.has(m[1])) {
      await rm(join(skillsDir, entry), { recursive: true, force: true })
    }
  }
}
