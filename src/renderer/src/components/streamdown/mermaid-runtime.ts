import { createMermaidPlugin, type DiagramPlugin, type MermaidInstance } from '@streamdown/mermaid'

import { MERMAID_RENDER_ID_ATTRIBUTE, rememberMermaidSource } from './mermaid-source-registry'

// Stamps the render id onto the SVG root so the DOM layer can look the source up again.
const annotateSvg = (svg: string, renderId: string): string =>
  svg.replace('<svg', `<svg ${MERMAID_RENDER_ID_ATTRIBUTE}="${renderId}"`)

const wrapInstance = (instance: MermaidInstance): MermaidInstance => ({
  initialize: (config) => instance.initialize(config),
  render: async (renderId, source) => {
    // Remembered even when rendering fails: the error panel can fall back to the same source.
    rememberMermaidSource(renderId, source)
    // Mermaid image shapes fetch through new Image() before an SVG exists. Parse shape metadata
    // before rendering, including quoted/escaped YAML keys; a post-render sanitizer is too late.
    if (/@\s*\{/.test(source)) {
      const { default: renderer } = await import('mermaid')
      const diagram = await renderer.mermaidAPI.getDiagramFromText(source)
      const db = diagram.db as { getVertices?: () => Map<string, { img?: string }> }
      if (db.getVertices && [...db.getVertices().values()].some((vertex) => vertex.img)) {
        throw new Error('MERMAID_IMAGE_BLOCKED')
      }
    }
    const result = await instance.render(renderId, source)
    return { ...result, svg: annotateSvg(result.svg, renderId) }
  }
})

// Same plugin as the upstream default export, with per-render source capture layered on.
const createSourceTrackingPlugin = (): DiagramPlugin => {
  const plugin = createMermaidPlugin()
  return {
    ...plugin,
    getMermaid: (config) => wrapInstance(plugin.getMermaid(config))
  }
}

const mermaid = createSourceTrackingPlugin()

export { mermaid }
