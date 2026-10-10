import type { ToolDescriptor } from '../../connector-core/types'
import { VARIANTS_GNOMAD_TOOLS } from './variants-gnomad'
import { VARIANTS_CLINVAR_TOOLS } from './variants-clinvar'
import { VARIANTS_DBSNP_TOOLS } from './variants-dbsnp'
import { VARIANTS_MAVEDB_TOOLS } from './variants-mavedb'

// "Variants" connector: gnomAD population frequencies/constraint, structural and mitochondrial
// variants and liftover; ClinVar records/search; dbSNP; and MaveDB functional assays.
// Tools are split by upstream source and aggregated here in display order.
export const VARIANTS_TOOLS: ToolDescriptor[] = [
  ...VARIANTS_GNOMAD_TOOLS,
  ...VARIANTS_CLINVAR_TOOLS,
  ...VARIANTS_DBSNP_TOOLS,
  ...VARIANTS_MAVEDB_TOOLS
]
