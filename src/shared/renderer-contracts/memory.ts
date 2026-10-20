import type {
  CreateMemoryCategoryRequest,
  CreateMemoryEntryRequest,
  DeleteMemoryCategoryRequest,
  DeleteMemoryEntryRequest,
  MemoryChangedEvent,
  MemorySnapshot,
  SetMemoryEnabledRequest,
  UpdateMemoryCategoryRequest,
  UpdateMemoryEntryRequest
} from '../memory'

import {
  callable,
  WEB,
  RUNTIME_VALIDATED,
  type AcpListener,
  type RemoveListener,
  EVENT
} from './definition'

export const contracts = {
  'memory.clearAll': callable<() => Promise<MemorySnapshot>>()('memory', [
    'memory:clear-all',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'memory.createCategory': callable<
    (request: CreateMemoryCategoryRequest) => Promise<MemorySnapshot>
  >()('memory', ['memory:create-category', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'memory.createEntry': callable<(request: CreateMemoryEntryRequest) => Promise<MemorySnapshot>>()(
    'memory',
    ['memory:create-entry', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'memory.deleteCategory': callable<
    (request: DeleteMemoryCategoryRequest) => Promise<MemorySnapshot>
  >()('memory', ['memory:delete-category', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'memory.deleteEntry': callable<(request: DeleteMemoryEntryRequest) => Promise<MemorySnapshot>>()(
    'memory',
    ['memory:delete-entry', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'memory.onChanged': callable<(listener: AcpListener<MemoryChangedEvent>) => RemoveListener>()(
    'memory',
    ['memory:changed', EVENT]
  ),
  'memory.setEnabled': callable<(request: SetMemoryEnabledRequest) => Promise<MemorySnapshot>>()(
    'memory',
    ['memory:set-enabled', WEB, undefined, undefined, RUNTIME_VALIDATED]
  ),
  'memory.snapshot': callable<() => Promise<MemorySnapshot>>()('memory', [
    'memory:snapshot',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'memory.updateCategory': callable<
    (request: UpdateMemoryCategoryRequest) => Promise<MemorySnapshot>
  >()('memory', ['memory:update-category', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'memory.updateEntry': callable<(request: UpdateMemoryEntryRequest) => Promise<MemorySnapshot>>()(
    'memory',
    ['memory:update-entry', WEB, undefined, undefined, RUNTIME_VALIDATED]
  )
} as const
