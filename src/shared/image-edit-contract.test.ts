import { describe, expect, it } from 'vitest'
import {
  buildImageEditPrompt,
  imageEditSnapshotSchema,
  type ImageEditSnapshot
} from './image-edit-contract'

const edit = (): ImageEditSnapshot => ({
  version: 1 as const,
  source: {
    projectId: 'project-1',
    sourceSessionId: 'source-session',
    sourceKind: 'artifact-version' as const,
    sourceFileId: 'file-1',
    sourceVersionId: 'version-1',
    name: 'coast.png',
    mimeType: 'image/png' as const
  },
  model: { serviceId: '11111111-1111-4111-8111-111111111111', modelId: 'relay/h3:local' },
  options: { size: '1024x1024' },
  naturalSize: { width: 128, height: 128 },
  regions: [
    {
      id: 'region-1',
      number: 1,
      instruction: 'Warm sand',
      geometry: { kind: 'rectangle' as const, start: { x: 0, y: 0 }, end: { x: 0.5, y: 0.5 } }
    },
    {
      id: 'region-2',
      number: 2,
      instruction: 'Move here',
      geometry: { kind: 'arrow' as const, start: { x: 0.5, y: 0.5 }, end: { x: 1, y: 1 } }
    }
  ]
})
describe('independent image edit snapshot', () => {
  it.each([
    { ...edit(), version: 2 },
    { ...edit(), source: { ...edit().source, path: 'file:///private/input.png' } },
    { ...edit(), model: { ...edit().model, apiKey: 'never-persist' } },
    { ...edit(), regions: [edit().regions[0], edit().regions[0]] },
    { ...edit(), naturalSize: { width: 20_000_000, height: 2 } },
    {
      ...edit(),
      regions: [
        {
          ...edit().regions[0],
          geometry: {
            kind: 'polygon',
            points: [
              { x: 0, y: 0 },
              { x: 0.5, y: 0.5 },
              { x: 1, y: 1 }
            ]
          }
        }
      ]
    },
    {
      ...edit(),
      regions: [{ ...edit().regions[0], geometry: { kind: 'point', point: { x: 2, y: 0 } } }]
    }
  ])('rejects malformed or unsupported spatial task inputs', (input) => {
    expect(imageEditSnapshotSchema.safeParse(input).success).toBe(false)
  })
})

it('rounds Seedream coordinates without collapsing a rectangle at the image edge', () => {
  const [rectangle, arrow] = edit().regions
  rectangle.geometry = {
    kind: 'rectangle',
    start: { x: 0.9998, y: 0 },
    end: { x: 1, y: 0.0001 }
  }
  const prompt = buildImageEditPrompt('', [rectangle, arrow], 'separate-reference', 'seedream/5.5')
  expect(prompt).toContain('图1<bbox>998 0 999 1</bbox>')
  expect(prompt).toContain('图1<point>999 999</point>')
})
