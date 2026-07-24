import { describe, expect, it } from 'vitest'

import {
  getActivityGroupTitleFromToolEvent,
  isActivityGroupToolEvent,
  sanitizeActivityGroupTitle
} from './activity-groups'

describe('activity group tool events', () => {
  it.each([
    'mcp__open-science-activity__begin_activity_group',
    'open-science-activity_begin_activity_group',
    'mcp__open_science_activity__begin_activity_group'
  ])('recognizes framework tool identity %s', (providerToolName) => {
    expect(isActivityGroupToolEvent({ providerToolName })).toBe(true)
  })

  it('extracts native and Codex-wrapped arguments', () => {
    expect(
      getActivityGroupTitleFromToolEvent({
        providerToolName: 'mcp__open-science-activity__begin_activity_group',
        rawInput: { title: 'Inspect the implementation.' }
      })
    ).toBe('Inspect the implementation')
    expect(
      getActivityGroupTitleFromToolEvent({
        rawInput: {
          server: 'open-science-activity',
          tool: 'begin_activity_group',
          arguments: { title: 'Apply the focused change' }
        }
      })
    ).toBe('Apply the focused change')
  })

  it('does not trust a bare leaf name without a server-qualified identity', () => {
    expect(isActivityGroupToolEvent({ providerToolName: 'begin_activity_group' })).toBe(false)
    expect(
      isActivityGroupToolEvent({
        providerToolName: 'mcp__open-science-activity__begin_activity_group'
      })
    ).toBe(true)
  })

  it('bounds and normalizes titles', () => {
    expect(sanitizeActivityGroupTitle(`Title: "${'x'.repeat(100)}."`)?.length).toBe(80)
  })
})
