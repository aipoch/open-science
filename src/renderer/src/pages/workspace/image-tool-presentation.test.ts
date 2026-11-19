import { describe, expect, it } from 'vitest'
import {
  imageToolOperation,
  readImageToolResult,
  readImageToolError
} from './image-tool-presentation'
import { buildToolActivityDetails } from './workspace-tool-activity-details'
import type { ToolActivity } from '@/stores/session-store-contract'

const result = {
  artifactId: 'artifact-1',
  versionId: 'version-1',
  filename: 'diagram.jpg',
  width: 1200,
  height: 800
}
it.each([
  result,
  { structuredContent: result },
  { content: [{ type: 'text', text: JSON.stringify(result) }] },
  {
    type: 'content',
    content: {
      type: 'text',
      text: JSON.stringify(result).replace(
        '"width":1200,',
        '"cacheTokens": [redacted]\n"width":1200,'
      )
    }
  }
])('reads the exact generated version across tool envelopes and historical redaction', (value) => {
  expect(readImageToolResult(value)).toEqual(result)
})
it('does not turn an error or unrelated MCP into a generated-image preview', () => {
  expect(readImageToolResult({ isError: true, structuredContent: result })).toBeUndefined()
  expect(imageToolOperation('mcp__other__generate_image')).toBeUndefined()
  const activity: ToolActivity = {
    id: 't',
    kind: 'tool',
    title: 'mcp__open_science_images__generate_image',
    status: 'failed',
    createdAt: 1,
    updatedAt: 1,
    eventIds: [],
    sortIndex: 1,
    rawOutput: result,
    rawInput: { prompt: 'Draw a diagram' }
  }
  const details = buildToolActivityDetails(activity)!
  expect(details.image?.result).toBeUndefined()
  expect(details.sections).toEqual([expect.objectContaining({ label: 'Error' })])
})

it('recognizes image approvals using the canonical MCP identity', () => {
  expect(imageToolOperation('open-science-images/generate_image')).toBe('generate')
  expect(imageToolOperation('open-science-images/edit_image')).toBe('edit')
  expect(imageToolOperation('other-images/edit_image')).toBeUndefined()
})
describe('image activity presentation', () => {
  it('shows the image card without raw input and output sections', () => {
    const details = buildToolActivityDetails({
      id: 't',
      kind: 'tool',
      title: 'mcp__open-science-images__edit_image',
      status: 'completed',
      createdAt: 1,
      updatedAt: 1,
      eventIds: [],
      sortIndex: 1,
      rawOutput: result,
      rawInput: { prompt: 'Make it blue' }
    })!
    expect(details.image).toEqual({ operation: 'edit', result })
    expect(details.sections).toEqual([])
  })
})

it('extracts structured failures through ACP text envelopes without rendering raw errors', () => {
  const imageError = { code: 'QUOTA_EXCEEDED', httpStatus: 429 }
  const rawOutput = {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ imageError, message: 'diagnostic' }) }]
  }
  expect(readImageToolError(rawOutput)).toEqual(imageError)
  expect(readImageToolResult(rawOutput)).toBeUndefined()
  expect(
    readImageToolError({ imageError: { code: 'NOT_A_CODE', message: 'secret' } })
  ).toBeUndefined()
  const details = buildToolActivityDetails({
    id: 't',
    kind: 'tool',
    title: 'generate_image',
    status: 'failed',
    rawOutput
  } as ToolActivity)
  expect(details?.image?.error).toEqual(imageError)
  expect(details?.sections).toEqual([])
})
