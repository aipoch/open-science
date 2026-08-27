import { describe, expect, it } from 'vitest'

import {
  annotationPayloadText,
  prepareAnnotationsForAgent,
  type Annotation,
  type ImagePointAnnotation
} from '../../../../../shared/annotations'
import { prepareImagePointAnnotations } from './image-annotation-payload'

const image = (
  id: string,
  versionId: string,
  point: { x: number; y: number }
): ImagePointAnnotation => ({
  id,
  kind: 'image-point',
  target: 'agent',
  note: `note for ${id}`,
  source: {
    kind: 'artifact-version',
    projectId: 'project-1',
    sessionId: 'session-1',
    versionId,
    name: 'figure.png',
    path: `artifact-version:project-1/session-1/artifact-1/${versionId}`,
    mimeType: 'image/png'
  },
  point,
  naturalSize: { width: 1200, height: 800 }
})

describe('image annotation Agent payload projection', () => {
  it('keeps mixed annotation ordering, stable image numbering, and one attachment per Version', () => {
    const annotations: Annotation[] = [
      image('point-1', 'version-1', { x: 0, y: 1 }),
      {
        id: 'quote-1',
        kind: 'text',
        target: 'agent',
        quote: 'Compare this sentence.',
        source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }
      },
      image('point-2', 'version-1', { x: 0.5, y: 0.5 }),
      image('point-3', 'version-2', { x: 1, y: 0 })
    ]

    expect(prepareImagePointAnnotations(annotations)).toEqual({
      attachments: [
        {
          id: 'artifact-1',
          name: 'figure.png',
          path: 'artifact-version:project-1/session-1/artifact-1/version-1',
          source: 'artifact',
          mimeType: 'image/png',
          versionId: 'version-1'
        },
        {
          id: 'artifact-1',
          name: 'figure.png',
          path: 'artifact-version:project-1/session-1/artifact-1/version-2',
          source: 'artifact',
          mimeType: 'image/png',
          versionId: 'version-2'
        }
      ],
      points: [
        expect.objectContaining({
          annotationId: 'point-1',
          number: 1,
          attachment: 1,
          x: 0,
          y: 799
        }),
        expect.objectContaining({
          annotationId: 'point-2',
          number: 2,
          attachment: 1,
          x: 600,
          y: 400
        }),
        expect.objectContaining({
          annotationId: 'point-3',
          number: 3,
          attachment: 2,
          x: 1199,
          y: 0
        })
      ]
    })
    expect(prepareImagePointAnnotations(annotations).points[0]).toMatchObject({
      imageWidth: 1200,
      imageHeight: 800,
      note: 'note for point-1',
      versionId: 'version-1'
    })
    expect(annotationPayloadText(annotations)).toBe(
      '[Annotations]\n' +
        JSON.stringify({
          items: [
            {
              type: 'image-point',
              source: {
                kind: 'artifact-version',
                artifactId: 'artifact-1',
                versionId: 'version-1',
                name: 'figure.png'
              },
              imageAttachment: 1,
              x: 0,
              y: 799,
              instruction: 'note for point-1'
            },
            { type: 'quote', content: 'Compare this sentence.' },
            {
              type: 'image-point',
              source: {
                kind: 'artifact-version',
                artifactId: 'artifact-1',
                versionId: 'version-1',
                name: 'figure.png'
              },
              imageAttachment: 1,
              x: 600,
              y: 400,
              instruction: 'note for point-2'
            },
            {
              type: 'image-point',
              source: {
                kind: 'artifact-version',
                artifactId: 'artifact-1',
                versionId: 'version-2',
                name: 'figure.png'
              },
              imageAttachment: 2,
              x: 1199,
              y: 0,
              instruction: 'note for point-3'
            }
          ]
        })
    )
    expect(annotationPayloadText(annotations)).not.toContain('"point":{"x":0.5')
  })

  it('keeps Agent attachment ordinals aligned when existing references precede annotated images', () => {
    const prepared = prepareAnnotationsForAgent(
      'Compare the marked points.',
      [
        image('point-1', 'version-1', { x: 0, y: 1 }),
        image('point-2', 'version-2', { x: 1, y: 0 })
      ],
      [
        {
          id: 'artifact-other',
          name: 'other.png',
          path: 'artifact-version:project-1/session-1/artifact-other/version-other',
          source: 'artifact',
          versionId: 'version-other'
        },
        {
          id: 'artifact-1',
          name: 'figure.png',
          path: 'artifact-version:project-1/session-1/artifact-1/version-2',
          source: 'artifact',
          versionId: 'version-2'
        },
        {
          id: 'artifact-1',
          name: 'figure.png',
          path: 'artifact-version:project-1/session-1/artifact-1/version-1',
          source: 'artifact',
          versionId: 'version-1'
        }
      ]
    )

    expect(prepared.promptText).toContain(
      '"type":"image-point","source":{"kind":"artifact-version","artifactId":"artifact-1","versionId":"version-1","name":"figure.png"},"imageAttachment":1,"x":0,"y":799'
    )
    expect(prepared.promptText).toContain(
      '"type":"image-point","source":{"kind":"artifact-version","artifactId":"artifact-1","versionId":"version-2","name":"figure.png"},"imageAttachment":2,"x":1199,"y":0'
    )
    expect(
      prepared.referencedArtifacts?.map((reference) =>
        'versionId' in reference ? reference.versionId : undefined
      )
    ).toEqual(['version-1', 'version-2', 'version-other'])
  })

  it('identifies an annotated upload Version without inventing an Artifact identity', () => {
    const annotation: ImagePointAnnotation = {
      id: 'upload-point',
      kind: 'image-point',
      target: 'agent',
      note: 'Inspect the uploaded image.',
      source: {
        kind: 'upload-version',
        projectId: 'project-1',
        sessionId: 'session-1',
        versionId: 'upload-version-1',
        name: 'uploaded.png',
        path: 'upload-version:project-1/session-1/upload-version-1',
        mimeType: 'image/png'
      },
      point: { x: 0.25, y: 0.75 },
      naturalSize: { width: 400, height: 200 }
    }

    expect(annotationPayloadText([annotation])).toContain(
      '"source":{"kind":"upload-version","versionId":"upload-version-1","name":"uploaded.png"}'
    )
    expect(annotationPayloadText([annotation])).not.toContain('artifactId')
  })
})
