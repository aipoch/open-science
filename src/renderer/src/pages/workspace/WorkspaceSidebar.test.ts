import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const workspaceSidebarSource = readFileSync(resolve(__dirname, 'WorkspaceSidebar.tsx'), 'utf8')
const mainCssSource = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')

describe('workspace sidebar session status indicators', () => {
  // The active session states need real theme tokens so Tailwind emits visible dot colors.
  it('uses defined semantic colors for running and permission-waiting sessions', () => {
    expect(workspaceSidebarSource).toContain(
      "running: 'bg-session-running ring-2 ring-session-running/20'"
    )
    expect(workspaceSidebarSource).toContain(
      "'waiting-permission': 'bg-session-waiting ring-2 ring-session-waiting/25'"
    )
    expect(workspaceSidebarSource).not.toContain('bg-chart-2')
    expect(workspaceSidebarSource).not.toContain('bg-chart-3')

    expect(mainCssSource).toContain('--color-session-running: var(--session-running);')
    expect(mainCssSource).toContain('--color-session-waiting: var(--session-waiting);')
    expect(mainCssSource).toContain('--session-running:')
    expect(mainCssSource).toContain('--session-waiting:')
  })
})
