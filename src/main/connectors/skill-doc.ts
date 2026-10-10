import { renderSkillDoc as render } from './skill-document-renderer'
import { CONNECTOR_CATALOG } from '@aipoch/connector-builtins/catalog'
import { getConnectorTools } from './registry'
export { renderConnectorInstructions, renderCustomSkillDoc } from './skill-document-renderer'
export type { CustomSkillDocServer, CustomSkillDocTool } from './skill-document-renderer'

export function renderSkillDoc(connectorId: string): string {
  const meta = CONNECTOR_CATALOG.find((entry) => entry.id === connectorId)
  if (!meta) throw new Error(`unknown connector: ${connectorId}`)
  return render(meta, getConnectorTools(connectorId))
}
