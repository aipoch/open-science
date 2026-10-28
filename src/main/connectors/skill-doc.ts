import { renderSkillDoc as render } from './skill-document-renderer'
import { CONNECTOR_CATALOG } from './catalog'
import { getConnectorTools } from './registry'
export { renderConnectorInstructions, renderCustomSkillDoc } from './skill-document-renderer'
export type { CustomSkillDocServer, CustomSkillDocTool } from './skill-document-renderer'

export function renderSkillDoc(connectorId: string): string {
  const meta = CONNECTOR_CATALOG.find((entry) => entry.id === connectorId)
  if (!meta) throw new Error(`unknown connector: ${connectorId}`)
  const guidance = [
    ...([
      'research-datasets',
      'ctd',
      'chea3',
      'biodbnet',
      'europepmc',
      'genes',
      'cellosaurus',
      'drug-regulatory'
    ].includes(connectorId)
      ? [
          'Official file URLs are discovery metadata, not completed downloads or local artifact paths. Use the official supported acquisition route and the existing Notebook/file workflows for authorized files. Do not invent a login/API-key binding, request secrets in tool arguments, infer data approval from metadata, or bypass an official access challenge.'
        ]
      : []),
    ...(connectorId === 'encori'
      ? [
          'Downloads follow the existing Connector permission settings; explicit user policies, Skip approvals and remembered grants retain their existing precedence. Specialist capability scopes follow their existing independent policy.'
        ]
      : []),
    ...(['interproscan', 'genomes', 'variants'].includes(connectorId)
      ? [
          'Configure required contact email in Settings → Credentials → Literature access. Tool inputs and outputs may be retained in conversation or Notebook persistence.'
        ]
      : []),
    ...(connectorId === 'molecule'
      ? [
          'Save the returned molfile with write_artifact_file, or use preview_molecule to attach it to the current turn and open the preview.'
        ]
      : [])
  ].join(' ')
  return render(meta, getConnectorTools(connectorId), guidance)
}
