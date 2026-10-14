import type { AcpMessageImage } from './acp-image-contract'

export type SessionTextAnnotationItemType =
  | 'tool-activity'
  | 'plan'
  | 'elicitation'
  | 'delegated-elicitation'
  | 'subagent-message'
  | 'notebook-run'
  | 'review'

export type TextAnnotationSource =
  | Readonly<{
      kind: 'agent-message'
      sessionId: string
      messageId: string
    }>
  | Readonly<{
      kind: 'project-file'
      projectId: string
      path: string
      name?: string
      fileSource?: 'artifact' | 'upload'
      sourceFileId?: string
      versionId?: string
      sessionId?: string
    }>
  | Readonly<{
      kind: 'session-item'
      sessionId: string
      itemId: string
      itemType: SessionTextAnnotationItemType
      sectionId?: string
    }>

export type TextAnnotationAnchor = Pick<PdfTextSelector, 'position' | 'prefix' | 'suffix'>

export type TextAnnotation = Readonly<{
  id: string
  kind: 'text'
  target: 'agent'
  quote: string
  anchor?: TextAnnotationAnchor
  note?: string
  source: TextAnnotationSource
}>

export type ImagePointAnnotation = Readonly<{
  id: string
  kind: 'image-point'
  target: 'agent'
  note: string
  source: Readonly<{
    kind: 'artifact-version' | 'upload-version'
    projectId: string
    sessionId: string
    versionId: string
    name: string
    path: string
    mimeType: string
  }>
  point: Readonly<{ x: number; y: number }>
  naturalSize: Readonly<{ width: number; height: number }>
}>

export type PdfNormalizedQuad = Readonly<{
  x: number
  y: number
  width: number
  height: number
}>

export type PdfNormalizedRect = PdfNormalizedQuad

export type PdfTextSelector = Readonly<{
  kind: 'text'
  pageNumber: number
  exact: string
  prefix?: string
  suffix?: string
  position: Readonly<{ start: number; end: number }>
  quads: readonly PdfNormalizedQuad[]
  extractorVersion: string
}>

export type PdfRegionSelector = Readonly<{
  kind: 'region'
  pageNumber: number
  rect: PdfNormalizedRect
  pageRotation: number
  text?: string
}> &
  (
    | Readonly<{ image: AcpMessageImage; imageOmissionReason?: never }>
    | Readonly<{ image?: never; imageOmissionReason: 'session-budget' }>
  )

export type PdfAnnotation = Readonly<{
  id: string
  kind: 'pdf'
  target: 'agent'
  note?: string
  source: Readonly<{
    kind: 'artifact-version' | 'upload-version' | 'literature-attachment-version'
    projectId: string
    sessionId?: string
    versionId: string
    name: string
    path: string
    checksum: string
  }>
  selector: PdfTextSelector | PdfRegionSelector
}>

export type Annotation = TextAnnotation | ImagePointAnnotation | PdfAnnotation
