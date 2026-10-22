import { expect, it } from 'vitest'
import { boundaryViolations, createDependencyReader, dependencyLayer } from './index.mjs'

it('rejects reversed layers and private cross-owner imports, including type relationships', () => {
  const modules = {
    pdf_documents: {
      ownerPaths: ['src/main/pdf-documents/api.ts', 'src/main/pdf-documents/internal.ts'],
      interfacePaths: ['src/main/pdf-documents/api.ts']
    }
  }
  const edges = new Map([
    ['src/shared/in-flight-promise.ts', new Set(['src/shared/contract.ts'])],
    ['src/shared/contract.ts', new Set(['src/main/service.ts'])],
    [
      'src/main/service.ts',
      new Set(['src/main/composition/document-reading.ts', 'src/main/pdf-documents/internal.ts'])
    ],
    ['src/main/composition/document-reading.ts', new Set(['src/main/pdf-documents/api.ts'])],
    ['src/main/pdf-documents/api.ts', new Set(['src/main/pdf-documents/internal.ts'])]
  ])
  expect(boundaryViolations(edges, modules)).toHaveLength(4)
  expect(
    boundaryViolations(
      new Map([
        ['src/main/composition/document-reading.ts', new Set(['src/main/service.ts'])],
        ['src/main/service.ts', new Set(['src/shared/ports.ts', 'src/main/pdf-documents/api.ts'])],
        ['src/renderer/src/store.ts', new Set(['src/shared/contract.ts'])]
      ]),
      modules
    )
  ).toEqual([])
  expect(dependencyLayer('src/main/service.test.ts')).toBe('test')
})

it.each([
  ["import type { Value } from './owner'", false],
  ["import { type Value } from './owner'", false],
  ["export { type Value } from './owner'", false],
  ["export type * from './owner'", false],
  ["import { type Value, schema } from './owner'", true],
  ["import Default, { type Value } from './owner'", true],
  ["export { type Value, schema } from './owner'", true],
  ["import './owner'", true],
  ["import {} from './owner'", true],
  ["export {} from './owner'", true],
  ["export * from './owner'", true],
  ["vi.mock('./owner')", true]
])('separates types from runtime dependencies without dropping effects: %s', (text, reachable) => {
  const contents = new Map([
    ['src/test.ts', String(text)],
    ['src/owner.ts', 'export const schema = 1; export type Value = string']
  ])
  const source = { files: new Set(contents.keys()), read: (path: string) => contents.get(path) }
  const owners = new Set(['src/owner.ts'])
  expect(createDependencyReader(source, [])('src/test.ts', owners).reachable).toBe(true)
  expect(
    createDependencyReader(source, [], { runtimeOnly: true })('src/test.ts', owners).reachable
  ).toBe(reachable)
  expect(
    createDependencyReader(source, [['src/owner.ts', ['src/test.ts']]], {
      runtimeOnly: true
    })('src/test.ts', owners).reachable
  ).toBe(true)
})

it('enforces reviewed file roles inside mixed modules instead of trusting module names', () => {
  const cases = [
    ['src/main/settings/types.ts', 'src/main/agent-framework/index.ts'],
    ['src/main/settings/document-shape.ts', 'src/main/settings/backend-resolver.ts'],
    ['src/main/settings/credential-store-mode.ts', 'src/main/settings/repository.ts'],
    ['src/main/mac-installation.ts', 'src/main/settings/backend-resolver.ts'],
    ['src/main/websocket-frame-sender.ts', 'src/main/composition/side-chat.ts'],
    ['src/main/settings/provider-accounts.ts', 'src/main/composition/artifacts.ts'],
    ['src/main/settings/backend-resolver.ts', 'src/renderer/src/pages/settings/SettingsPage.tsx'],
    [
      'src/renderer/src/pages/workspace/composer-model-picker-utils.ts',
      'src/renderer/src/pages/workspace/WorkspacePage.tsx'
    ],
    [
      'src/renderer/src/pages/workspace/pdf-annotations/PdfAnnotationPreviewDialog.tsx',
      'src/main/settings/types.ts'
    ]
  ]
  for (const [source, target] of cases)
    expect(
      boundaryViolations(new Map([[source, new Set([target])]]), {}),
      `${source} -> ${target}`
    ).toHaveLength(1)
  expect(
    boundaryViolations(
      new Map([
        ['src/main/settings/types.ts', new Set(['src/shared/settings.ts'])],
        [
          'src/main/settings/device-credentials-codec.ts',
          new Set(['src/main/settings/types.ts', 'src/main/settings/connector-template.ts'])
        ],
        [
          'src/main/settings/backend-resolver.ts',
          new Set(['src/main/settings/provider-accounts.ts'])
        ],
        ['src/main/side-chat/host-message-mcp-server.ts', new Set(['src/shared/side-chat.ts'])]
      ]),
      {}
    )
  ).toEqual([])
  expect(dependencyLayer('src/main/settings/credential-store-mode.ts')).toBe('bootstrap-state')
  expect(dependencyLayer('src/main/settings/types.ts')).toBe('record-contract')
  expect(dependencyLayer('src/main/settings/device-credentials-codec.ts')).toBe('record-codec')
})

it('keeps host contracts, infrastructure, repositories and presentation in their own roles', () => {
  const reversed = [
    [
      'src/main/credential-identity/identity-contract.ts',
      'src/main/credential-identity/selection.ts'
    ],
    ['src/main/credential-identity/node-cipher.ts', 'src/main/credential-identity/selection.ts'],
    ['src/main/node-process-host.ts', 'src/main/agent-framework/types.ts'],
    ['src/main/reviewer/tool-input-contract.ts', 'src/main/reviewer/bounded-artifact-content.ts'],
    ['src/main/pdf-annotations/repository.ts', 'src/main/pdf-annotations/application-commands.ts'],
    ['src/main/runtime-network.ts', 'src/main/composition/artifacts.ts'],
    [
      'src/main/settings/network-proxy-runtime.ts',
      'src/main/pdf-annotations/application-commands.ts'
    ],
    ['src/main/connectors/catalog.ts', 'src/main/connectors/service.ts'],
    ['src/shared/pdf-annotations.ts', 'src/main/pdf-annotations/native-import-core.ts']
  ]
  for (const [source, target] of reversed)
    expect(
      boundaryViolations(new Map([[source, new Set([target])]]), {}),
      `${source} -> ${target}`
    ).toHaveLength(1)
  expect(
    boundaryViolations(
      new Map([
        [
          'src/main/credential-identity/node-cipher.ts',
          new Set(['src/main/credential-identity/identity-contract.ts'])
        ],
        ['src/main/pdf-annotations/repository.ts', new Set(['src/shared/pdf-annotations.ts'])],
        ['src/main/process-tree-windows.ts', new Set(['src/main/node-process-host.ts'])],
        [
          'src/main/reviewer/bounded-artifact-content.ts',
          new Set(['src/main/reviewer/tool-input-contract.ts'])
        ]
      ]),
      {}
    )
  ).toEqual([])
})

it('separates renderer projections from mutable stores and visual adapters', () => {
  const reversed = [
    [
      'src/renderer/src/components/job-binding-utils.ts',
      'src/renderer/src/stores/session-store.ts'
    ],
    [
      'src/renderer/src/components/notification-inbox-presentation.ts',
      'src/renderer/src/stores/notification-inbox-store.ts'
    ],
    [
      'src/renderer/src/lib/package-operation-presentation.ts',
      'src/renderer/src/stores/package-operation-store.ts'
    ],
    [
      'src/renderer/src/pages/workspace/session-plan/active-branch-plan.ts',
      'src/renderer/src/stores/session-store.ts'
    ],
    [
      'src/renderer/src/stores/notification-inbox-store.ts',
      'src/renderer/src/components/NotificationBell.tsx'
    ],
    ['src/renderer/src/stores/review-store.ts', 'src/renderer/src/components/ReviewerCard.tsx'],
    ['src/main/reviewer/review-json.ts', 'src/main/reviewer/repository.ts'],
    ['src/main/reviewer/repository.ts', 'src/main/reviewer/host-sdk.ts']
  ]
  for (const [source, target] of reversed)
    expect(
      boundaryViolations(new Map([[source, new Set([target])]]), {}),
      `${source} -> ${target}`
    ).toHaveLength(1)
  expect(
    boundaryViolations(
      new Map([
        [
          'src/renderer/src/components/job-binding-utils.ts',
          new Set(['src/renderer/src/stores/session-store-contract.ts'])
        ],
        [
          'src/renderer/src/lib/package-operation-presentation.ts',
          new Set(['src/shared/session-package.ts'])
        ],
        [
          'src/renderer/src/components/NotificationBell.tsx',
          new Set(['src/renderer/src/stores/notification-inbox-store.ts'])
        ],
        ['src/main/reviewer/repository.ts', new Set(['src/main/reviewer/review-json.ts'])]
      ]),
      {}
    )
  ).toEqual([])
})

it('keeps preview contracts and projections below renderer state and adapters', () => {
  for (const [source, target] of [
    [
      'src/renderer/src/stores/preview-workbench-contract.ts',
      'src/renderer/src/stores/preview-workbench-store.ts'
    ],
    [
      'src/renderer/src/pages/workspace/preview-support.ts',
      'src/renderer/src/stores/preview-workbench-store.ts'
    ],
    [
      'src/renderer/src/pages/workspace/preview-file-item.ts',
      'src/renderer/src/stores/session-store.ts'
    ],
    [
      'src/renderer/src/pages/workspace/follow-notebook-scroll.ts',
      'src/renderer/src/stores/preview-workbench-store.ts'
    ],
    [
      'src/renderer/src/stores/preview-workbench-store.ts',
      'src/renderer/src/pages/workspace/LocalFileBrowser.tsx'
    ],
    [
      'src/renderer/src/components/action-menu/action-menu-model.ts',
      'src/renderer/src/components/action-menu/ActionMenuProvider.tsx'
    ]
  ]) {
    expect(
      boundaryViolations(new Map([[source, new Set([target])]]), {}),
      `${source} -> ${target}`
    ).toHaveLength(1)
  }
  expect(
    boundaryViolations(
      new Map([
        [
          'src/renderer/src/pages/workspace/preview-file-item.ts',
          new Set([
            'src/renderer/src/stores/preview-workbench-contract.ts',
            'src/renderer/src/stores/session-store-contract.ts'
          ])
        ],
        [
          'src/renderer/src/stores/preview-workbench-store.ts',
          new Set(['src/renderer/src/stores/preview-workbench-contract.ts'])
        ],
        [
          'src/renderer/src/components/action-menu/ActionMenuProvider.tsx',
          new Set(['src/renderer/src/components/action-menu/action-menu-model.ts'])
        ]
      ]),
      {}
    )
  ).toEqual([])
})
