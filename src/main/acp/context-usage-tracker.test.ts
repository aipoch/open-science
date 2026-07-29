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
    expect(tokenizerProfileFor('opencode', 'openai/gpt-5')).toBe('o200k_base')
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

  it('deduplicates a pre-counted Codex Skill when the same SKILL.md is read', () => {
    const tracker = new ContextUsageTracker(wordCounter)
    tracker.beginSession('s1', { frameworkId: 'codex', model: 'gpt-5.6-sol' })
    tracker.recordSkillDocument('s1', '/codex/skills/pdf/SKILL.md', 'skill content here')
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
      { key: 'skills', tokens: 3, estimated: true },
      { key: 'other', tokens: 2, estimated: false }
    ])
  })
})
