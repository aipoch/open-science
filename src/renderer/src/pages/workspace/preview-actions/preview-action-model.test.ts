// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Check } from 'lucide-react'

import { resolveActionMenuEntries } from '@/components/action-menu'

import {
  LOCAL_PREVIEW_MENU_RECIPE,
  MANAGED_PREVIEW_MENU_RECIPE,
  PREVIEW_CAPABILITY_CATALOG,
  shouldHandlePreviewContextMenu,
  type PreviewActionBindings,
  type PreviewMenuRecipeEntry
} from './preview-action-model'

describe('preview action model', () => {
  const execute = (): void => undefined
  const allBindings: PreviewActionBindings = {
    'pdf-context': { execute },
    'copy-path': { execute },
    'save-as-artifact': { execute },
    provenance: { execute },
    'view-in-context': { execute },
    download: { execute },
    'open-fullscreen': { execute },
    close: { execute }
  }

  it('puts local-only capabilities above the shared preview actions', () => {
    const entries = resolveActionMenuEntries(
      {
        identityKey: 'local-preview',
        catalog: PREVIEW_CAPABILITY_CATALOG,
        recipe: LOCAL_PREVIEW_MENU_RECIPE,
        bindings: allBindings
      },
      undefined
    )

    expect(entries.map((entry) => (entry.kind === 'action' ? entry.action : entry.kind))).toEqual([
      'copy-path',
      'save-as-artifact',
      'separator',
      'provenance',
      'view-in-context',
      'open-fullscreen',
      'download',
      'close'
    ])
  })

  it('keeps managed shared capabilities in the requested order', () => {
    const entries = resolveActionMenuEntries(
      {
        identityKey: 'managed-preview',
        catalog: PREVIEW_CAPABILITY_CATALOG,
        recipe: MANAGED_PREVIEW_MENU_RECIPE,
        bindings: allBindings
      },
      undefined
    )

    expect(entries.map((entry) => (entry.kind === 'action' ? entry.action : entry.kind))).toEqual([
      'provenance',
      'view-in-context',
      'open-fullscreen',
      'download',
      'close'
    ])
  })

  it('removes separators left empty by hidden or unbound capabilities', () => {
    const execute = (): void => undefined
    const recipe: readonly PreviewMenuRecipeEntry[] = [
      { kind: 'separator' },
      { kind: 'action', action: 'copy-path' },
      { kind: 'separator' },
      { kind: 'separator' },
      { kind: 'action', action: 'download' },
      { kind: 'separator' },
      { kind: 'action', action: 'save-as-artifact' },
      { kind: 'separator' }
    ]

    const entries = resolveActionMenuEntries(
      {
        identityKey: 'preview',
        catalog: PREVIEW_CAPABILITY_CATALOG,
        recipe,
        bindings: {
          'copy-path': { execute, hidden: true },
          download: { execute }
        }
      },
      undefined
    )

    expect(entries.map((entry) => entry.kind)).toEqual(['action'])
    expect(entries[0]).toMatchObject({ kind: 'action', action: 'download' })
  })

  it('applies transient presentation and respects disabled bindings', () => {
    const entries = resolveActionMenuEntries(
      {
        identityKey: 'preview',
        catalog: PREVIEW_CAPABILITY_CATALOG,
        recipe: LOCAL_PREVIEW_MENU_RECIPE,
        bindings: {
          'copy-path': {
            execute: (): void => undefined,
            disabled: true,
            labelKey: 'Copied',
            icon: Check
          }
        }
      },
      undefined
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'action',
      action: 'copy-path',
      labelKey: 'Copied',
      icon: Check,
      disabled: true
    })
  })

  it('leaves editable and explicitly exempted surfaces to their native context menu', () => {
    const host = document.createElement('div')
    host.innerHTML = `
      <input data-target="input" />
      <textarea data-target="textarea"></textarea>
      <select data-target="select"><option>One</option></select>
      <button data-target="button"><span data-target="button-child">Run</span></button>
      <div contenteditable="true"><span data-target="editable-child"></span></div>
      <div data-preview-context-menu-passthrough><span data-target="passthrough-child"></span></div>
      <iframe data-target="iframe"></iframe>
      <div contenteditable="false" data-target="readonly"></div>
      <canvas data-target="preview"></canvas>
    `

    for (const target of ['input', 'textarea', 'select', 'button', 'button-child']) {
      expect(shouldHandlePreviewContextMenu(host.querySelector(`[data-target="${target}"]`))).toBe(
        false
      )
    }
    expect(
      shouldHandlePreviewContextMenu(host.querySelector('[data-target="editable-child"]'))
    ).toBe(false)
    expect(
      shouldHandlePreviewContextMenu(host.querySelector('[data-target="passthrough-child"]'))
    ).toBe(false)
    expect(shouldHandlePreviewContextMenu(host.querySelector('[data-target="iframe"]'))).toBe(false)
    expect(shouldHandlePreviewContextMenu(host.querySelector('[data-target="readonly"]'))).toBe(
      true
    )
    expect(shouldHandlePreviewContextMenu(host.querySelector('[data-target="preview"]'))).toBe(true)
  })
})
