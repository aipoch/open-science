import { Check, Download, Trash2 } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'

import {
  resolveActionMenuEntries,
  type ActionMenuBinding,
  type ActionMenuDefinition,
  type ActionMenuRecipeEntry
} from './action-menu-model'

type TestActionId = 'copy' | 'download' | 'delete'
type TestInvocation = { kind: 'message'; text: string; locked: boolean }

const catalog: Record<TestActionId, ActionMenuDefinition> = {
  copy: { labelKey: 'Copy', icon: Check },
  download: { labelKey: 'Download', icon: Download },
  delete: { labelKey: 'Delete', icon: Trash2, danger: true }
}

const execute = vi.fn()

describe('resolveActionMenuEntries', () => {
  it('combines catalog defaults with the recipe order and bound actions', () => {
    const recipe: readonly ActionMenuRecipeEntry<TestActionId>[] = [
      { kind: 'action', action: 'copy' },
      { kind: 'separator' },
      { kind: 'action', action: 'download' },
      { kind: 'action', action: 'delete' }
    ]
    const bindings: Partial<Record<TestActionId, ActionMenuBinding<TestInvocation>>> = {
      copy: { execute },
      delete: { execute }
    }

    const entries = resolveActionMenuEntries(
      { identityKey: 'message-1', catalog, recipe, bindings },
      { kind: 'message', text: 'snapshot', locked: false }
    )

    expect(entries).toEqual([
      {
        kind: 'action',
        action: 'copy',
        labelKey: 'Copy',
        icon: Check,
        danger: false,
        disabled: false
      },
      { kind: 'separator' },
      {
        kind: 'action',
        action: 'delete',
        labelKey: 'Delete',
        icon: Trash2,
        danger: true,
        disabled: false
      }
    ])
  })

  it('normalizes leading, trailing, and consecutive separators after hidden actions', () => {
    const recipe: readonly ActionMenuRecipeEntry<TestActionId>[] = [
      { kind: 'separator' },
      { kind: 'action', action: 'copy' },
      { kind: 'separator' },
      { kind: 'separator' },
      { kind: 'action', action: 'download' },
      { kind: 'separator' },
      { kind: 'action', action: 'delete' },
      { kind: 'separator' }
    ]
    const bindings: Partial<Record<TestActionId, ActionMenuBinding<TestInvocation>>> = {
      copy: { execute, hidden: true },
      download: { execute },
      delete: { execute, hidden: ({ locked }) => locked }
    }

    const entries = resolveActionMenuEntries(
      { identityKey: 'message-1', catalog, recipe, bindings },
      { kind: 'message', text: 'snapshot', locked: true }
    )

    expect(entries).toEqual([
      {
        kind: 'action',
        action: 'download',
        labelKey: 'Download',
        icon: Download,
        danger: false,
        disabled: false
      }
    ])
  })

  it('evaluates a dynamic recipe and every dynamic presentation value from the invocation', () => {
    const invocation: TestInvocation = { kind: 'message', text: 'Selected text', locked: true }
    const bindings: Partial<Record<TestActionId, ActionMenuBinding<TestInvocation>>> = {
      copy: {
        execute,
        labelKey: ({ text }) => `Copy ${text}`,
        icon: () => Download,
        danger: ({ locked }) => locked,
        disabled: ({ locked }) => locked,
        hidden: ({ text }) => text.length === 0
      }
    }

    const entries = resolveActionMenuEntries(
      {
        identityKey: 'message-1',
        catalog,
        recipe: ({ locked }) => [{ kind: 'action', action: locked ? 'copy' : 'download' }],
        bindings
      },
      invocation
    )

    expect(entries).toEqual([
      {
        kind: 'action',
        action: 'copy',
        labelKey: 'Copy Selected text',
        icon: Download,
        danger: true,
        disabled: true
      }
    ])
    expect(entries[0]).not.toHaveProperty('invocation')
    expect(entries[0]).not.toHaveProperty('execute')
  })
})
