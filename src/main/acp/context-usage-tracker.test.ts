import type { SessionNotification } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import {
  ContextUsageTracker,
  MAX_TOOL_ESTIMATE_CHARS,
  tokenizerProfileFor,
  type TokenCounter
} from './context-usage-tracker'

const wordCounter: TokenCounter = {
  count: (text) => text.trim().split(/\s+/).filter(Boolean).length
}

describe('ContextUsageTracker', () => {
  it('selects a stable local tokenizer profile by model before framework fallback', () => {
    expect(tokenizerProfileFor('claude-code', undefined)).toBe('anthropic')
    expect(tokenizerProfileFor('claude-code', 'deepseek-v4-flash')).toBe('cl100k_base')
    expect(tokenizerProfileFor('claude-code', 'gpt-5.6-sol')).toBe('o200k_base')
    expect(tokenizerProfileFor('opencode', 'claude-sonnet-4-5')).toBe('anthropic')
    expect(tokenizerProfileFor('opencode', 'anthropic/claude-sonnet-4-5')).toBe('anthropic')
    expect(tokenizerProfileFor('codex', 'gpt-5.6-sol')).toBe('o200k_base')
    expect(tokenizerProfileFor('codex', 'claude-sonnet-4-5')).toBe('anthropic')
    expect(tokenizerProfileFor('opencode', 'gpt-4.1-mini')).toBe('o200k_base')
    expect(tokenizerProfileFor('opencode', 'gpt-4.5-preview')).toBe('o200k_base')
    expect(tokenizerProfileFor('opencode', 'chatgpt-4o-latest')).toBe('o200k_base')
    expect(tokenizerProfileFor('opencode', 'openai/gpt-5')).toBe('o200k_base')
    expect(tokenizerProfileFor('opencode', 'azure:openai:gpt-4.5-preview')).toBe('o200k_base')
    expect(tokenizerProfileFor('opencode', 'openai.codex-mini-latest')).toBe('o200k_base')
    expect(tokenizerProfileFor('opencode', 'bedrock/us.anthropic.claude-3-7-sonnet-v1:0')).toBe(
      'anthropic'
    )
    expect(tokenizerProfileFor('opencode', 'deepseek-v4')).toBe('cl100k_base')
  })

  it('keeps local categories separate and reconciles the positive residual to Agent overhead', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', {
      frameworkId: 'claude-code',
      model: 'claude-sonnet-4-5',
      persistentSystemPrompt: ['system rules here']
    })
    tracker.appendText('s1', 'messages', 'hello from user')
    tracker.appendText('s1', 'skills', 'loaded skill instructions')

    expect(tracker.compare('s1', 12, 'reconciled')).toEqual({
      source: 'estimated',
      tokenizer: 'anthropic',
      model: 'claude-sonnet-4-5',
      estimatedTokens: 9,
      difference: 3,
      status: 'reconciled',
      categories: [
        { key: 'system', tokens: 3, estimated: true },
        { key: 'messages', tokens: 3, estimated: true },
        { key: 'skills', tokens: 3, estimated: true },
        { key: 'other', tokens: 3, estimated: false }
      ]
    })
  })

  it('exposes a local-only estimate before the Agent reports authoritative usage', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    tracker.appendText('s1', 'system', 'follow these rules')
    tracker.appendPromptContent('s1', 'answer this question')

    expect(tracker.estimate('s1')).toEqual({
      source: 'estimated',
      tokenizer: 'cl100k_base',
      model: 'deepseek-v4',
      estimatedTokens: 6,
      difference: 0,
      status: 'preflight',
      categories: [
        { key: 'system', tokens: 3, estimated: true },
        { key: 'messages', tokens: 3, estimated: true }
      ]
    })
  })

  it('defers assistant output until it becomes input to the next prompt', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    tracker.appendPromptContent('s1', 'first question')
    tracker.observeSessionUpdate('s1', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'answer-1',
        content: { type: 'text', text: 'generated answer content' }
      }
    })

    expect(tracker.estimate('s1')?.estimatedTokens).toBe(2)

    tracker.observeSessionUpdate('s1', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Search',
        status: 'in_progress',
        rawInput: { query: 'evidence' }
      }
    })

    expect(tracker.estimate('s1')?.categories).toContainEqual({
      key: 'messages',
      tokens: 5,
      estimated: true
    })

    tracker.commitPendingAssistantOutput('s1')
    tracker.appendPromptContent('s1', 'second question')

    expect(tracker.estimate('s1')?.estimatedTokens).toBe(8)
  })

  it('counts persistent app-owned tool schemas in their explicit category', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', {
      frameworkId: 'claude-code',
      model: 'deepseek-v4-flash',
      persistentSections: [
        {
          sectionId: 'mcp-schema:open-science-notebook',
          category: 'mcp',
          text: 'notebook execute schema'
        }
      ]
    })

    expect(tracker.compare('s1', 5, 'preflight')).toMatchObject({
      categories: [
        { key: 'mcp', tokens: 3, estimated: true },
        { key: 'other', tokens: 2, estimated: false }
      ]
    })
  })

  it('reports a negative comparison without hiding it through proportional scaling', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    tracker.appendText('s1', 'messages', 'one two three four five')

    expect(tracker.compare('s1', 3, 'preflight')).toMatchObject({
      estimatedTokens: 5,
      difference: -2,
      status: 'preflight',
      categories: [{ key: 'messages', tokens: 5, estimated: true }]
    })
  })

  it('restores a session checkpoint without retaining later turn estimates', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    tracker.appendText('s1', 'messages', 'committed history')
    const checkpoint = tracker.checkpointSession('s1')

    tracker.appendText('s1', 'messages', 'failed prompt content')
    tracker.replaceText('s1', 'tool:failed:input', 'tools', 'failed tool input')
    tracker.restoreSession('s1', checkpoint)

    expect(tracker.compare('s1', 5, 'reconciled')?.categories).toEqual([
      { key: 'messages', tokens: 2, estimated: true },
      { key: 'other', tokens: 3, estimated: false }
    ])
  })

  it('drops buffered assistant output when restoring a failed control-turn checkpoint', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    tracker.appendPromptContent('s1', 'committed history')
    const checkpoint = tracker.checkpointSession('s1')

    tracker.observeSessionUpdate('s1', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'hidden-control-output',
        content: { type: 'text', text: 'compaction failed hidden output' }
      }
    })
    tracker.restoreSession('s1', checkpoint)
    tracker.commitPendingAssistantOutput('s1')

    expect(tracker.estimate('s1')?.categories).toEqual([
      { key: 'messages', tokens: 2, estimated: true }
    ])
  })

  it('attributes a repeated framework prefix to system instead of messages', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    tracker.appendText('s1', 'system', 'follow these rules')
    tracker.appendPromptContent('s1', 'follow these rules\n\nanswer this', 'follow these rules')

    expect(tracker.compare('s1', 8, 'preflight')).toMatchObject({
      estimatedTokens: 5,
      categories: [
        { key: 'system', tokens: 3, estimated: true },
        { key: 'messages', tokens: 2, estimated: true },
        { key: 'other', tokens: 3, estimated: false }
      ]
    })
  })

  it('replaces cumulative tool snapshots instead of double-counting them', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })

    const first: SessionNotification = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read',
        status: 'in_progress',
        rawInput: { path: 'one' }
      }
    }
    const second: SessionNotification = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        rawInput: { path: 'one two' },
        rawOutput: 'three four'
      }
    }

    tracker.observeSessionUpdate('s1', first)
    tracker.observeSessionUpdate('s1', second)

    expect(tracker.compare('s1', 10, 'reconciled')).toMatchObject({
      estimatedTokens: 4,
      categories: [
        { key: 'tools', tokens: 4, estimated: true },
        { key: 'other', tokens: 6, estimated: false }
      ]
    })
  })

  it('counts one tool result when raw output and display content mirror each other', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    tracker.observeSessionUpdate('s1', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'Read',
        status: 'completed',
        rawInput: { path: 'paper.pdf' },
        rawOutput: 'result text here',
        content: [{ type: 'content', content: { type: 'text', text: 'result text here' } }]
      }
    })

    expect(tracker.estimate('s1')).toMatchObject({
      estimatedTokens: 4,
      categories: [{ key: 'tools', tokens: 4, estimated: true }]
    })
  })

  it('keeps canonical raw output when a later partial update contains only display content', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    tracker.observeSessionUpdate('s1', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'in_progress',
        rawOutput: 'canonical raw result'
      }
    })
    tracker.observeSessionUpdate('s1', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'longer display projection of the same result' }
          }
        ]
      }
    })

    expect(tracker.estimate('s1')).toMatchObject({
      estimatedTokens: 3,
      categories: [{ key: 'tools', tokens: 3, estimated: true }]
    })
  })

  it('bounds tool serialization and tokenization before traversing the full payload', () => {
    const observedLengths: number[] = []
    const tracker = new ContextUsageTracker({
      count: (text) => {
        observedLengths.push(text.length)
        return text.length
      }
    })
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    let itemReads = 0
    const rawOutput = new Proxy(new Array(20_000).fill('payload'), {
      get(target, property, receiver) {
        if (property !== 'length') itemReads += 1
        return Reflect.get(target, property, receiver)
      }
    })

    tracker.observeSessionUpdate('s1', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'large-tool',
        status: 'completed',
        rawOutput,
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'x'.repeat(MAX_TOOL_ESTIMATE_CHARS * 2) }
          }
        ]
      }
    })

    expect(itemReads).toBeLessThan(2_100)
    expect(Math.max(...observedLengths)).toBeLessThanOrEqual(MAX_TOOL_ESTIMATE_CHARS)
    expect(
      tracker.compare('s1', MAX_TOOL_ESTIMATE_CHARS, 'reconciled')?.estimatedTokens
    ).toBeLessThanOrEqual(MAX_TOOL_ESTIMATE_CHARS)
  })

  it('classifies native Skill tool content separately from conversation messages', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'claude-code', model: 'claude-sonnet-4-5' })
    tracker.observeSessionUpdate('s1', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'skill-1',
        title: 'Loaded skill: pdf',
        status: 'completed',
        rawInput: { name: 'pdf' },
        content: [{ type: 'content', content: { type: 'text', text: 'skill content here' } }]
      }
    })

    expect(tracker.compare('s1', 7, 'reconciled')).toMatchObject({
      estimatedTokens: 4,
      categories: [
        { key: 'skills', tokens: 4, estimated: true },
        { key: 'other', tokens: 3, estimated: false }
      ]
    })
  })

  it('counts a native Skill document once when raw output and content repeat it', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'claude-code', model: 'claude-sonnet-4-5' })
    tracker.observeSessionUpdate('s1', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'skill-1',
        title: 'Loaded skill: pdf',
        status: 'completed',
        rawInput: { name: 'pdf' },
        rawOutput: 'skill content here',
        content: [{ type: 'content', content: { type: 'text', text: 'skill content here' } }]
      }
    })

    expect(tracker.estimate('s1')).toMatchObject({
      estimatedTokens: 4,
      categories: [{ key: 'skills', tokens: 4, estimated: true }]
    })
  })

  it('counts a failed native Skill load as ordinary tool output', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'claude-code', model: 'claude-sonnet-4-5' })
    tracker.observeSessionUpdate('s1', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'skill-1',
        title: 'Loading skill: pdf',
        status: 'failed',
        rawInput: { name: 'pdf' },
        rawOutput: 'skill load failed'
      }
    })

    expect(tracker.estimate('s1')?.categories).toEqual([
      { key: 'tools', tokens: 4, estimated: true }
    ])
  })

  it('accepts an MCP classification from the runtime session boundary', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'codex', model: 'gpt-5.6-sol' })
    tracker.observeSessionUpdate(
      's1',
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'mcp-1',
          title: 'notebook_execute',
          status: 'in_progress',
          rawInput: 'run notebook cell'
        }
      },
      { toolCategory: 'mcp' }
    )

    expect(tracker.compare('s1', 5, 'reconciled')?.categories).toEqual([
      { key: 'mcp', tokens: 3, estimated: true },
      { key: 'other', tokens: 2, estimated: false }
    ])
  })

  it('keeps an MCP tool classified when a later result update omits its identity', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    tracker.observeSessionUpdate(
      's1',
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'mcp-1',
          title: 'open-science-notebook_notebook_execute',
          status: 'in_progress',
          rawInput: 'run notebook cell'
        }
      },
      { toolCategory: 'mcp' }
    )
    tracker.observeSessionUpdate('s1', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'mcp-1',
        status: 'completed',
        rawOutput: 'notebook result data'
      }
    })

    expect(tracker.estimate('s1')?.categories).toEqual([{ key: 'mcp', tokens: 6, estimated: true }])
  })

  it('treats a reused tool call id in a later prompt as a new history entry', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    tracker.appendPromptContent('s1', '')
    tracker.observeSessionUpdate(
      's1',
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'reused-id',
          status: 'completed',
          rawOutput: 'first MCP result'
        }
      },
      { toolCategory: 'mcp' }
    )

    tracker.appendPromptContent('s1', '')
    tracker.observeSessionUpdate('s1', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'reused-id',
        status: 'completed',
        rawOutput: 'second tool result'
      }
    })

    expect(tracker.estimate('s1')?.categories).toEqual([
      { key: 'tools', tokens: 3, estimated: true },
      { key: 'mcp', tokens: 3, estimated: true }
    ])
  })

  it('deduplicates a pre-counted Codex Skill when the same SKILL.md is read', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'codex', model: 'gpt-5.6-sol' })
    tracker.replacePromptSkillDocuments('s1', [
      { path: '/codex/skills/pdf/SKILL.md', text: 'skill content here' }
    ])
    tracker.observeSessionUpdate(
      's1',
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'read-1',
          title: 'Read',
          status: 'completed',
          rawInput: { path: '/codex/skills/pdf/SKILL.md' },
          content: [{ type: 'content', content: { type: 'text', text: 'skill content here' } }]
        }
      },
      { toolCategory: 'skills', skillFilePath: '/codex/skills/pdf/SKILL.md' }
    )

    expect(tracker.compare('s1', 5, 'reconciled')?.categories).toEqual([
      { key: 'skills', tokens: 4, estimated: true },
      { key: 'other', tokens: 1, estimated: false }
    ])
  })

  it('keeps the existing Skill document when a later read fails', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    const skillPath = '/codex/skills/pdf/SKILL.md'
    tracker.beginSession('s1', { frameworkId: 'codex', model: 'gpt-5.6-sol' })
    tracker.replacePromptSkillDocuments('s1', [
      { path: skillPath, text: 'real skill instructions' }
    ])
    tracker.observeSessionUpdate(
      's1',
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'read-1',
          title: 'Read',
          status: 'in_progress',
          rawInput: { path: skillPath }
        }
      },
      { toolCategory: 'skills', skillFilePath: skillPath }
    )
    tracker.observeSessionUpdate('s1', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'read-1',
        status: 'failed',
        rawOutput: 'permission denied error'
      }
    })

    expect(tracker.estimate('s1')?.categories).toEqual([
      { key: 'tools', tokens: 3, estimated: true },
      { key: 'skills', tokens: 4, estimated: true }
    ])
  })

  it('counts later explicit reads of the same SKILL.md as separate history entries', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    const skillPath = '/codex/skills/pdf/SKILL.md'
    tracker.beginSession('s1', { frameworkId: 'codex', model: 'gpt-5.6-sol' })
    tracker.replacePromptSkillDocuments('s1', [{ path: skillPath, text: 'skill content here' }])

    const observeRead = (toolCallId: string): void => {
      tracker.observeSessionUpdate(
        's1',
        {
          sessionId: 's1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            title: 'Read',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'skill content here' } }]
          }
        },
        { toolCategory: 'skills', skillFilePath: skillPath }
      )
    }

    observeRead('read-1')
    observeRead('read-1')
    observeRead('read-2')
    tracker.appendPromptContent('s1', '')
    observeRead('read-1')

    expect(tracker.estimate('s1')?.categories).toEqual([
      { key: 'skills', tokens: 9, estimated: true }
    ])
  })

  it('keeps Skill read input and canonical raw output across projected updates', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    const skillPath = '/codex/skills/pdf/SKILL.md'
    tracker.beginSession('s1', { frameworkId: 'codex', model: 'gpt-5.6-sol' })
    tracker.observeSessionUpdate(
      's1',
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'read-1',
          title: 'Read',
          status: 'completed',
          rawInput: { path: skillPath },
          rawOutput: 'full skill document'
        }
      },
      { toolCategory: 'skills', skillFilePath: skillPath }
    )
    tracker.observeSessionUpdate('s1', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'read-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'short projection' } }]
      }
    })

    expect(tracker.estimate('s1')?.categories).toEqual([
      { key: 'skills', tokens: 4, estimated: true }
    ])
  })

  it('replaces prompt-scoped Codex Skill documents on the next turn', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'codex', model: 'gpt-5.6-sol' })
    tracker.replacePromptSkillDocuments('s1', [
      { path: '/codex/skills/pdf/SKILL.md', text: 'prompt skill content' }
    ])

    expect(tracker.estimate('s1')?.categories).toContainEqual({
      key: 'skills',
      tokens: 3,
      estimated: true
    })

    tracker.replacePromptSkillDocuments('s1', [])

    expect(tracker.estimate('s1')?.categories).not.toContainEqual(
      expect.objectContaining({ key: 'skills' })
    )
  })

  it('keeps a prompt Skill after an observed file read promotes it to persistent history', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    const skillPath = '/codex/skills/pdf/SKILL.md'
    tracker.beginSession('s1', { frameworkId: 'codex', model: 'gpt-5.6-sol' })
    tracker.replacePromptSkillDocuments('s1', [{ path: skillPath, text: 'skill content here' }])
    tracker.observeSessionUpdate(
      's1',
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'read-1',
          title: 'Read',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'skill content here' } }]
        }
      },
      { toolCategory: 'skills', skillFilePath: skillPath }
    )

    tracker.replacePromptSkillDocuments('s1', [{ path: skillPath, text: 'skill content here' }])
    tracker.replacePromptSkillDocuments('s1', [])

    expect(tracker.estimate('s1')?.categories).toContainEqual({
      key: 'skills',
      tokens: 3,
      estimated: true
    })
  })

  it('owns provider reconciliation without exposing mutable usage collections', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    tracker.appendText('s1', 'messages', 'one two three')
    tracker.reconcileProviderUsage('s1', { used: 8, size: 64_000 }, 128_000)

    const snapshot = tracker.usageSnapshot()
    expect(snapshot.s1).toMatchObject({
      used: 8,
      size: 128_000,
      breakdown: { status: 'reconciled', estimatedTokens: 3, difference: 5 }
    })

    snapshot.s1.used = 999
    snapshot.s1.breakdown?.categories.splice(0)

    expect(tracker.usageSnapshot().s1).toMatchObject({
      used: 8,
      breakdown: {
        categories: [
          { key: 'messages', tokens: 3, estimated: true },
          { key: 'other', tokens: 5, estimated: false }
        ]
      }
    })
  })

  it('restores the last provider reading when a preflight estimate receives no fresh update', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    tracker.appendText('s1', 'messages', 'committed history')
    tracker.reconcileProviderUsage('s1', { used: 20, size: 128_000 })
    const checkpoint = tracker.checkpointSession('s1')

    tracker.appendPromptContent('s1', 'new prompt')
    expect(tracker.refreshUsage('s1', 'preflight', 128_000)).toBe(true)
    expect(tracker.usage('s1')?.breakdown?.status).toBe('preflight')

    expect(tracker.restorePreflightUsage('s1', checkpoint)).toBe(true)
    expect(tracker.usageSnapshot().s1).toMatchObject({
      used: 20,
      size: 128_000,
      breakdown: { status: 'reconciled' }
    })
  })

  it('closes a completed turn once and restores its transient preflight reading', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    tracker.appendText('s1', 'messages', 'committed history')
    tracker.reconcileProviderUsage('s1', { used: 20, size: 128_000 })

    const turn = tracker.beginTurn('s1')
    tracker.appendPromptContent('s1', 'new prompt')
    tracker.observeSessionUpdate('s1', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'answer-1',
        content: { type: 'text', text: 'completed answer' }
      }
    })
    expect(tracker.refreshUsage('s1', 'preflight', 128_000)).toBe(true)

    expect(turn.complete()).toBe(true)
    expect(turn.complete()).toBe(false)
    expect(tracker.usage('s1')).toMatchObject({
      used: 20,
      size: 128_000,
      breakdown: { status: 'reconciled' }
    })

    tracker.commitPendingAssistantOutput('s1')
    expect(tracker.estimate('s1')?.categories).toContainEqual({
      key: 'messages',
      tokens: 6,
      estimated: true
    })
  })

  it('freezes the current prompt estimate instead of the previous provider total', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    tracker.appendText('s1', 'messages', 'committed history')
    tracker.reconcileProviderUsage('s1', { used: 20, size: 128_000 })

    const turn = tracker.beginTurn('s1')
    tracker.appendPromptContent('s1', 'new prompt')
    expect(tracker.refreshUsage('s1', 'preflight', 128_000)).toBe(true)

    expect(turn.captureTerminal()).toMatchObject({
      source: 'local-estimate',
      contextWindow: {
        used: 4,
        size: 128_000,
        breakdown: { status: 'preflight', estimatedTokens: 4 }
      }
    })
  })

  it('distinguishes fresh provider updates from terminal provider responses', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    tracker.reconcileProviderUsage('s1', { used: 20, size: 128_000 })

    const updated = tracker.beginTurn('s1')
    tracker.reconcileProviderUsage('s1', { used: 42, size: 128_000 })
    expect(updated.captureTerminal()).toMatchObject({
      source: 'provider-update',
      contextWindow: { used: 42, size: 128_000 }
    })
    updated.complete()

    const responded = tracker.beginTurn('s1')
    expect(tracker.reconcileUsed('s1', 51)).toBe(true)
    expect(responded.captureTerminal(true)).toMatchObject({
      source: 'provider-response',
      contextWindow: { used: 51, size: 128_000 }
    })
  })

  it('cannot capture a terminal snapshot after a turn settles or is superseded', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode' })
    tracker.reconcileProviderUsage('s1', { used: 20, size: 128_000 })

    const completed = tracker.beginTurn('s1')
    completed.complete()
    expect(completed.captureTerminal()).toBeUndefined()

    const failed = tracker.beginTurn('s1')
    failed.fail()
    expect(failed.captureTerminal()).toBeUndefined()

    const superseded = tracker.beginTurn('s1')
    superseded.supersede()
    expect(superseded.captureTerminal()).toBeUndefined()
  })

  it('rolls back a turn rejected before provider data to its captured checkpoint', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    tracker.appendText('s1', 'messages', 'committed history')
    tracker.reconcileProviderUsage('s1', { used: 20, size: 128_000 })
    const beforeTurn = tracker.usage('s1')

    const turn = tracker.beginTurn('s1')
    tracker.appendPromptContent('s1', 'rejected prompt content')
    tracker.replaceText('s1', 'prompt-skill', 'skills', 'rejected skill content')
    expect(tracker.refreshUsage('s1', 'preflight', 128_000)).toBe(true)

    turn.fail()
    turn.fail()
    expect(tracker.usage('s1')).toEqual(beforeTurn)
    expect(tracker.estimate('s1')?.categories).toEqual([
      { key: 'messages', tokens: 2, estimated: true }
    ])
  })

  it('retains a partially observed failed turn while restoring prior authoritative usage', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    tracker.appendText('s1', 'messages', 'committed history')
    tracker.reconcileProviderUsage('s1', { used: 20, size: 128_000 })
    const beforeTurn = tracker.usage('s1')

    const turn = tracker.beginTurn('s1')
    tracker.appendPromptContent('s1', 'new prompt')
    expect(tracker.refreshUsage('s1', 'preflight', 128_000)).toBe(true)
    tracker.observeSessionUpdate('s1', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'partial-answer',
        content: { type: 'text', text: 'partial answer' }
      }
    })
    tracker.observeSessionUpdate('s1', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'partial-tool',
        status: 'completed',
        rawOutput: 'partial tool result'
      }
    })

    turn.fail()
    turn.fail()
    expect(tracker.usage('s1')).toEqual(beforeTurn)
    tracker.commitPendingAssistantOutput('s1')
    expect(tracker.estimate('s1')?.categories).toEqual([
      { key: 'tools', tokens: 3, estimated: true },
      { key: 'messages', tokens: 6, estimated: true }
    ])
  })

  it('does not let a superseded turn restore over its successor revision', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'opencode', model: 'deepseek-v4' })
    tracker.reconcileProviderUsage('s1', { used: 20, size: 128_000 })

    const stale = tracker.beginTurn('s1')
    tracker.appendPromptContent('s1', 'first prompt')
    expect(tracker.refreshUsage('s1', 'preflight', 128_000)).toBe(true)

    const successor = tracker.beginTurn('s1')
    tracker.appendPromptContent('s1', 'successor prompt')
    tracker.reconcileProviderUsage('s1', { used: 42, size: 128_000 })

    stale.fail()
    expect(stale.complete()).toBe(false)
    stale.supersede()
    expect(tracker.usage('s1')).toMatchObject({
      used: 42,
      size: 128_000,
      breakdown: { status: 'reconciled' }
    })

    successor.supersede()
    successor.supersede()
  })

  it('invalidates a matching turn when its estimate session resets', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    const input = { frameworkId: 'opencode' as const, model: 'deepseek-v4' }
    tracker.beginSession('s1', input)
    tracker.reconcileProviderUsage('s1', { used: 20, size: 128_000 })
    const stale = tracker.beginTurn('s1')
    tracker.appendPromptContent('s1', 'old prompt')
    expect(tracker.refreshUsage('s1', 'preflight', 128_000)).toBe(true)

    tracker.resetSession('s1', input)
    tracker.reconcileProviderUsage('s1', { used: 7, size: 128_000 })

    stale.fail()
    expect(tracker.usage('s1')).toMatchObject({ used: 7, size: 128_000 })
  })

  it('invalidates a matching turn when its session is deleted and reused', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    const input = { frameworkId: 'opencode' as const, model: 'deepseek-v4' }
    tracker.beginSession('s1', input)
    tracker.reconcileProviderUsage('s1', { used: 20, size: 128_000 })
    const stale = tracker.beginTurn('s1')
    tracker.appendPromptContent('s1', 'deleted prompt')
    expect(tracker.refreshUsage('s1', 'preflight', 128_000)).toBe(true)

    tracker.deleteSession('s1')
    tracker.beginSession('s1', input)
    tracker.reconcileProviderUsage('s1', { used: 7, size: 128_000 })

    stale.fail()
    expect(tracker.usage('s1')).toMatchObject({ used: 7, size: 128_000 })
  })

  it('invalidates every matching turn when its provider generation clears', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    const input = { frameworkId: 'opencode' as const, model: 'deepseek-v4' }
    tracker.beginSession('s1', input)
    tracker.beginSession('s2', input)
    const staleTurns = [tracker.beginTurn('s1'), tracker.beginTurn('s2')]
    tracker.appendPromptContent('s1', 'old prompt one')
    tracker.appendPromptContent('s2', 'old prompt two')

    tracker.clear()
    tracker.beginSession('s1', input)
    tracker.reconcileProviderUsage('s1', { used: 7, size: 128_000 })

    for (const turn of staleTurns) turn.fail()
    expect(tracker.usage('s1')).toMatchObject({ used: 7, size: 128_000 })
  })

  it('invalidates a prompt turn when compaction captures its own checkpoint', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    const input = { frameworkId: 'claude-code' as const, model: 'claude-sonnet-4-5' }
    tracker.beginSession('s1', input)
    tracker.reconcileProviderUsage('s1', { used: 100, size: 200_000 })
    const stale = tracker.beginTurn('s1')
    tracker.appendPromptContent('s1', 'overflowing prompt')
    expect(tracker.refreshUsage('s1', 'preflight', 200_000)).toBe(true)

    const compactionCheckpoint = tracker.checkpointSession('s1')
    tracker.reconcileProviderUsage('s1', { used: 12, size: 200_000 })

    stale.fail()
    tracker.resetAfterCompaction('s1', input, compactionCheckpoint, 200_000)
    expect(tracker.usage('s1')).toMatchObject({
      used: 12,
      size: 200_000,
      breakdown: { status: 'reconciled' }
    })
  })

  it('keeps only a fresh provider reading after context compaction', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    const input = { frameworkId: 'claude-code' as const, model: 'claude-sonnet-4-5' }
    tracker.beginSession('stale', input)
    tracker.reconcileProviderUsage('stale', { used: 100, size: 200_000 })
    const staleCheckpoint = tracker.checkpointSession('stale')

    tracker.resetAfterCompaction('stale', input, staleCheckpoint, 200_000)
    expect(tracker.usageSnapshot().stale).toBeUndefined()

    tracker.beginSession('fresh', input)
    tracker.appendText('fresh', 'messages', 'compacted conversation')
    tracker.reconcileProviderUsage('fresh', { used: 100, size: 200_000 })
    const freshCheckpoint = tracker.checkpointSession('fresh')
    tracker.reconcileProviderUsage('fresh', { used: 12, size: 200_000 })
    tracker.resetAfterCompaction('fresh', input, freshCheckpoint, 200_000)

    expect(tracker.usageSnapshot().fresh).toMatchObject({
      used: 12,
      size: 200_000,
      breakdown: { status: 'reconciled' }
    })
  })
})
