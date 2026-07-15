import type { ToolDescriptor } from '../types'

// The interactive Ketcher app: unlike the read-only HTTP connectors, these four tools do NOT run through
// ParserEngine. They are registered here so the settings UI, per-tool policy and skill doc treat Ketcher
// like any other connector; ConnectorService.callBundled special-cases `ketcher` and routes dispatch to
// the main-process KetcherService (which drives a live sketcher tile) instead of an upstream API.
export const KETCHER_TOOLS: ToolDescriptor[] = [
  {
    id: 'open_sketcher',
    connector: 'ketcher',
    description:
      'Open an interactive 2D molecule sketcher tile for the user, seeded from an optional structure. Creates a .ket artifact and mounts an editable Ketcher canvas; returns the artifact_id used by the other ketcher tools.',
    input: {
      type: 'object',
      properties: {
        ket: { type: 'string', description: 'Initial structure as Ketcher KET JSON.' },
        molfile: { type: 'string', description: 'Initial structure as an MDL molfile.' },
        rxn: { type: 'string', description: 'Initial reaction as an MDL rxnfile.' },
        smiles: { type: 'string', description: 'Initial structure as a SMILES string.' },
        filename: {
          type: 'string',
          description: 'Optional display filename for the artifact (a .ket extension is enforced).'
        }
      }
    },
    returns:
      '`{ "artifact_id": str, "filename": str }` — `artifact_id` identifies the mounted sketcher tile; pass it to set_structure / highlight_atoms / get_structure. When no seed is given the canvas opens blank.',
    example: 'result = host.mcp("ketcher", "open_sketcher", {"smiles": "CC(=O)OC1=CC=CC=C1C(=O)O"})'
  },
  {
    id: 'set_structure',
    connector: 'ketcher',
    description:
      'Replace the structure on a mounted sketcher canvas. Errors clearly when the artifact_id has no mounted tile (open a sketcher first).',
    input: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string', description: 'Id returned by open_sketcher.' },
        ket: { type: 'string', description: 'New structure as Ketcher KET JSON.' },
        molfile: { type: 'string', description: 'New structure as an MDL molfile.' },
        smiles: { type: 'string', description: 'New structure as a SMILES string.' }
      },
      required: ['artifact_id']
    },
    required: ['artifact_id'],
    returns:
      '`{ "ok": true }` on success; raises if the tile is not mounted or no structure is given.',
    example:
      'result = host.mcp("ketcher", "set_structure", {"artifact_id": "...", "smiles": "c1ccccc1"})'
  },
  {
    id: 'highlight_atoms',
    connector: 'ketcher',
    description:
      'Highlight atoms (and optionally bonds) on a mounted sketcher canvas by their 0-based indices.',
    input: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string', description: 'Id returned by open_sketcher.' },
        atoms: {
          type: 'array',
          items: { type: 'integer' },
          description: '0-based atom indices to highlight.'
        },
        bonds: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Optional 0-based bond indices to highlight.'
        },
        color: { type: 'string', description: 'Optional CSS color (default a light red).' }
      },
      required: ['artifact_id', 'atoms']
    },
    required: ['artifact_id', 'atoms'],
    returns: '`{ "ok": true }` on success; raises if the tile is not mounted.',
    example:
      'result = host.mcp("ketcher", "highlight_atoms", {"artifact_id": "...", "atoms": [0, 1, 2], "color": "#ffd54f"})'
  },
  {
    id: 'get_structure',
    connector: 'ketcher',
    description:
      'Read the current structure back from a mounted sketcher canvas in the requested format.',
    input: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string', description: 'Id returned by open_sketcher.' },
        format: {
          type: 'string',
          enum: ['ket', 'molfile', 'smiles'],
          default: 'ket',
          description: 'Serialization to return.'
        }
      },
      required: ['artifact_id']
    },
    required: ['artifact_id'],
    returns:
      '`{ "artifact_id": str, "format": str, "structure": str }` — `structure` is the canvas serialized in `format`. Raises if the tile is not mounted.',
    example:
      'result = host.mcp("ketcher", "get_structure", {"artifact_id": "...", "format": "smiles"})'
  }
]
