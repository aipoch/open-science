import type { ToolDescriptor } from '../types'
import { STRUCTURES_EMDB_TOOLS } from './structures-emdb'
import { STRUCTURES_COMPLEXPORTAL_TOOLS } from './structures-complexportal'
import { STRUCTURES_INTACT_TOOLS } from './structures-intact'
import { STRUCTURES_PDB_TOOLS } from './structures-pdb'
import { STRUCTURES_ALPHAFOLD_TOOLS } from './structures-alphafold'

// "Structures & Interactions" connector: 3D structures and molecular interactions across PDB,
// AlphaFold, EMDB (cryo-EM), Complex Portal, and IntAct. Tools are split across descriptor files
// by upstream source; this module aggregates them in the connector's display order.
export const STRUCTURES_TOOLS: ToolDescriptor[] = [
  ...STRUCTURES_EMDB_TOOLS,
  ...STRUCTURES_COMPLEXPORTAL_TOOLS,
  ...STRUCTURES_INTACT_TOOLS,
  ...STRUCTURES_PDB_TOOLS,
  ...STRUCTURES_ALPHAFOLD_TOOLS
]
