import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ComputeHost } from '../../shared/compute'

// Skill directory name for the remote-compute-ssh Phase-1 skill doc. Using a fixed name (not
// host-specific) because the skill teaches how to use the entire compute API — it lives alongside
// the connector mcp-* skill dirs so Claude Code discovers it as `remote-compute-ssh/SKILL.md`.
const COMPUTE_SKILL_DIR = 'remote-compute-ssh'

// Renders the Phase-1 skill doc. Includes the list of currently registered hosts so agents see
// them from context without needing to call list() first (design.md §5 "物化").
// Only teaches Phase-1 capabilities (list/create/call_command/compute_details). All Phase-2+
// operations (submit_job/harvest/wait_for_notification/save_artifacts/download) are excluded.
export const renderComputeSkillDoc = (hosts: ComputeHost[]): string => {
  const hostLines =
    hosts.length === 0
      ? '  (no hosts registered yet)'
      : hosts
          .map((h) => {
            const probe = h.probeResult
            const statusLabel =
              probe == null ? 'not yet probed' : probe.ok ? 'connected' : 'probe failed'
            return `  - ${h.displayName} (provider_id: \`${h.providerId}\`, shape: ${h.shape}, status: ${statusLabel})`
          })
          .join('\n')

  return `---
name: remote-compute-ssh
description: Discover and use SSH compute hosts. Load when you need to run remote commands or work with compute resources.
license: Apache-2.0
---

This skill covers Phase-1 remote compute capabilities: listing hosts, creating handles,
running short remote commands, and reading/writing host knowledge docs. Phase-2 operations
(job submission, output collection, notifications, and artifact management) are not available yet.

## Registered hosts

${hostLines}

Call \`host.compute.list()\` in a notebook cell to refresh this list at runtime.

## API reference (Phase 1)

\`\`\`python
# List all registered hosts (returns [{provider_id, display_name, shape, status}])
hosts = host.compute.list()

# Create a handle to a specific host (no network call)
c = host.compute.create('ssh:<alias>')

# Run a short remote command (raises RuntimeError on approval_denied / host_unreachable / timeout)
result = c.call_command(
    cmd='<shell command>',
    intent='<one-line description for the approval card>',
    login_shell=True,           # default: True — loads ~/.bash_profile so module/conda PATH is visible
    timeout_seconds=60,         # default: 60s
)
# result → {exit_code, stdout, stderr, truncated}

# Read the host knowledge doc (returns {doc, isSkeleton})
info = host.compute.details('ssh:<alias>', mode='read')

# Append a note to the host knowledge doc (agent writes; 32 KB cap enforced)
host.compute.details('ssh:<alias>', mode='append', text='\\n## Note\\nlearned X on <date>')

# Replace the entire host knowledge doc (old_text must match the current doc exactly)
host.compute.details('ssh:<alias>', mode='replace',
    text='<new full doc>',
    old_text=info['doc'])   # from the read above
\`\`\`

## Typical first-contact workflow

1. Call \`host.compute.details(provider_id, mode='read')\` — a \`## Resources\` skeleton means
   first contact; populated sections mean prior sessions did the legwork, trust them.
2. Bind once: \`c = host.compute.create(provider_id)\`.
3. Run one batched probe: \`c.call_command('id; module avail 2>&1 | head -40', intent=...)\`.
4. Append what you learned to the knowledge doc via \`host.compute.details(..., mode='append')\`.

## call_command error handling

\`\`\`python
try:
    r = c.call_command('cmd', intent='...')
except RuntimeError as e:
    code = getattr(e, 'error_code', '')
    if code == 'host_unreachable':
        # SSH connectivity issue — requires user action (VPN, key, etc.)
        pass
    elif code == 'approval_denied':
        # User declined the approval card
        pass
    elif code == 'timeout':
        # Command exceeded timeout_seconds
        pass
\`\`\`

## What to record in the knowledge doc

The knowledge doc is the only state that survives across sessions. Record:
- Scheduler type and any known partition/account combinations that worked.
- Environment activation commands (e.g. \`module load X/<ver>\`, \`conda activate <env>\`).
- Verified invocations tagged \`verified <date>\`; user-provided info tagged \`per user <date>\`.
- Gotchas specific to this host or provider.

Do NOT record per-job state, transient errors, or facts about your project — those belong
elsewhere. When a session ends without new host-specific learnings, write nothing.
`
}

// Writes skills/remote-compute-ssh/SKILL.md under skillsDir with the current host list.
// Creates the directory if absent; call again after any host create/delete to keep it fresh.
// Mirrors the syncConnectorSkillDocs pattern in src/main/connectors/provision.ts.
export async function syncComputeSkillDoc(skillsDir: string, hosts: ComputeHost[]): Promise<void> {
  await mkdir(skillsDir, { recursive: true })
  const dir = join(skillsDir, COMPUTE_SKILL_DIR)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), renderComputeSkillDoc(hosts), 'utf8')
}
