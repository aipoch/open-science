import { expect, it } from 'vitest'
import { mainlineGroups, selectWindowsMainline } from './windows-e2e-mainline.mjs'

const owner = (
  path: string,
  consumers: string[] = []
): { ownerPaths: string[]; consumerModules: string[] } => ({
  ownerPaths: [path],
  consumerModules: consumers
})
const manifest = {
  modules: {
    project_lifecycle: owner('src/main/projects/service.ts'),
    workspace_conversation: owner('src/renderer/conversation.tsx'),
    workspace_previews: owner('src/renderer/preview.tsx'),
    notebook_execution: owner('src/main/notebook/execute.ts'),
    main_windows: owner('src/main/windows.ts'),
    project_files: owner('src/main/project-files.ts', ['workspace_previews']),
    new_feature: owner('src/main/new-feature.ts')
  }
}
const select = (path: string, status = 'modified'): ReturnType<typeof selectWindowsMainline> =>
  selectWindowsMainline([{ path, status }], manifest)

it.each([
  ['src/main/projects/service.ts', ['projects']],
  ['src/renderer/conversation.tsx', ['conversation']],
  ['src/renderer/preview.tsx', ['files']],
  ['src/main/notebook/execute.ts', ['notebook']],
  ['src/main/windows.ts', ['windows']],
  ['docs/PRD.md', []]
])('selects only product mainlines affected by %s', (path, expected) => {
  expect(select(path).groups).toEqual(expected)
})

it('expands registered consumers and explains the dependency path', () => {
  const plan = select('src/main/project-files.ts')
  expect(plan.groups).toEqual(['projects', 'files'])
  expect(plan.reasons).toContain(
    'src/main/project-files.ts -> project_files -> workspace_previews -> files'
  )
})

it.each([
  'src/shared/ipc.ts',
  'src/preload/index.ts',
  'package-lock.json',
  'electron.vite.config.ts',
  'e2e/fixtures/electron-app.ts',
  'src/main/new-feature.ts',
  'unregistered.ts'
])('falls back to all mainlines, never full regression, for %s', (path) => {
  const plan = select(path)
  expect(plan.groups).toEqual(Object.keys(mainlineGroups))
  const pattern = new RegExp(plan.grep)
  expect(pattern.test('scientific workflow @pr-mainline-notebook')).toBe(true)
  expect(pattern.test('extended regression case')).toBe(false)
  expect(pattern.test('unregistered @pr-mainline-notebook-extra')).toBe(false)
})

it('includes all mainlines for destructive changes and rejects ambiguous ownership', () => {
  expect(select('src/main/windows.ts', 'deleted').groups).toEqual(Object.keys(mainlineGroups))
  expect(
    selectWindowsMainline([{ path: 'src/main/windows.ts', status: 'modified' }], {
      modules: { ...manifest.modules, duplicate: owner('src/main/windows.ts') }
    }).groups
  ).toEqual(Object.keys(mainlineGroups))
})

it('selects a modified mainline spec even without a source change', () => {
  expect(select('e2e/workspace-files.spec.ts').groups).toEqual(['files'])
})

it('unions mixed changes and handles cyclic consumer metadata without losing coverage', () => {
  const modules = {
    ...manifest.modules,
    workspace_previews: owner('src/renderer/preview.tsx', ['project_files'])
  }
  const plan = selectWindowsMainline(
    [
      { path: 'src/main/project-files.ts', status: 'modified' },
      { path: 'src/main/windows.ts', status: 'modified' }
    ],
    { modules }
  )
  expect(plan.groups).toEqual(['projects', 'files', 'windows'])
})
