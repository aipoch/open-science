import { resolveDataRoot } from '../storage-root'
import { decodeDataPath as decode, encodeDataPath as encode } from './data-path-codec'
export { DATA_ROOT_SENTINEL } from './data-path-codec'

// Desktop defaults stay outside the codec used by isolated, explicitly rooted readers.
export const encodeDataPath = (
  path: string | undefined,
  dataRoot = resolveDataRoot()
): string | undefined => encode(path, dataRoot)
export const decodeDataPath = (
  path: string | undefined,
  dataRoot = resolveDataRoot()
): string | undefined => decode(path, dataRoot)
