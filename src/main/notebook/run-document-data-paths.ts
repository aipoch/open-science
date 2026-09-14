import { resolveDataRoot } from '../storage-root'
import type { NotebookRunDocument } from '../../shared/notebook'
import {
  encodeRunDocumentDataPaths as encode,
  decodeRunDocumentDataPaths as decode
} from './run-document-data-path-codec'

export const encodeRunDocumentDataPaths = (
  doc: NotebookRunDocument,
  dataRoot = resolveDataRoot()
): NotebookRunDocument => encode(doc, dataRoot)
export const decodeRunDocumentDataPaths = (
  doc: NotebookRunDocument,
  dataRoot = resolveDataRoot()
): NotebookRunDocument => decode(doc, dataRoot)
