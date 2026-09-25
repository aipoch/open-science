/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseNameStatus } from './classify-pr-changes.mjs'
import { loadModuleImpactManifest } from './load-module-impact.mjs'

// These are product journeys, not complete suites. Uncertain impact selects all five journeys.
export const mainlineGroups = {
  projects: /project|session_persistence|session_deletion|session_package/,
  conversation: /conversation|session|acp|agent|permission|provider|delegation|reviewer/,
  files: /file|artifact|preview|literature|citation/,
  notebook: /notebook|compute|runtime|sandbox/,
  windows: /window|shortcut|keyboard|tray|native|app_lifecycle/
}
const specGroups = {
  'e2e/electron-foundation.spec.ts': ['projects', 'notebook'],
  'e2e/workspace-conversation.spec.ts': ['conversation'],
  'e2e/workspace-files.spec.ts': ['files'],
  'e2e/windows-window-system.spec.ts': ['windows']
}

export function selectWindowsMainline(changes, manifest) {
  const groups = new Set()
  const reasons = new Set()
  const all = (reason) => {
    Object.keys(mainlineGroups).forEach((group) => groups.add(group))
    reasons.add(`${reason} -> all mainline groups (complete regression remains scheduled)`)
  }
  const visit = (id, chain, visited = new Set()) => {
    if (visited.has(id)) return
    visited.add(id)
    const module = manifest.modules[id]
    if (!module) return all(`${chain} -> missing module ${id}`)
    const matches = Object.entries(mainlineGroups).filter(([, pattern]) => pattern.test(id))
    if (!matches.length) all(`${chain} -> ${id} -> unmapped E2E owner`)
    for (const [group] of matches) {
      groups.add(group)
      reasons.add(`${chain} -> ${id} -> ${group}`)
    }
    for (const consumer of module.consumerModules) visit(consumer, `${chain} -> ${id}`, visited)
  }
  for (const change of changes) {
    for (const path of [change.path, change.previousPath].filter(Boolean)) {
      if (/\.md$|^docs\//.test(path)) continue
      if (!['added', 'modified'].includes(change.status)) {
        all(`${path} -> ${change.status}`)
      } else if (specGroups[path]) {
        for (const group of specGroups[path]) {
          groups.add(group)
          reasons.add(`${path} -> mainline spec -> ${group}`)
        }
      } else if (
        /^(src\/shared\/|src\/preload\/|package(?:-lock)?\.json$|\.github\/|scripts\/|e2e\/fixtures\/|.*(?:vite|playwright|tsconfig|vitest).*config)/.test(
          path
        )
      ) {
        all(`${path} -> shared contract, fixture or CI/build input`)
      } else {
        const owners = Object.entries(manifest.modules).filter(([, module]) =>
          module.ownerPaths.includes(path)
        )
        if (owners.length !== 1) all(`${path} -> unknown or ambiguous owner`)
        else visit(owners[0][0], path)
      }
    }
  }
  const selected = Object.keys(mainlineGroups).filter((group) => groups.has(group))
  return {
    groups: selected,
    grep: selected.length ? `@pr-mainline-(${selected.join('|')})(?:\\s|$)` : '',
    reasons: [...reasons].sort()
  }
}

export function runMainlineSelection(environment = process.env) {
  for (const name of ['BASE_SHA', 'HEAD_SHA']) {
    if (!/^[0-9a-f]{40}$/i.test(environment[name] ?? '')) throw new Error(`Invalid ${name}`)
  }
  const changes = parseNameStatus(
    execFileSync(
      'git',
      ['diff', '--name-status', '-z', environment.BASE_SHA, environment.HEAD_SHA],
      { encoding: 'utf8' }
    )
  )
  const plan = selectWindowsMainline(changes, loadModuleImpactManifest())
  if (environment.GITHUB_OUTPUT) appendFileSync(environment.GITHUB_OUTPUT, `grep=${plan.grep}\n`)
  if (environment.GITHUB_STEP_SUMMARY) {
    const escape = (text) =>
      text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    appendFileSync(
      environment.GITHUB_STEP_SUMMARY,
      `\n## Windows mainline E2E\n\nGroups: ${plan.groups.join(', ') || 'none'}\n\n${plan.reasons.map((reason) => `- <code>${escape(reason)}</code>`).join('\n')}\n`
    )
  }
  return plan
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMainlineSelection()
