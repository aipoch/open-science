import type {
  InitializeLocalePreferenceRequest,
  SetLocalePreferenceRequest
} from '../../shared/locale'
import { ipcMainHandle } from '../ipc-handler-registry'
import { broadcastToRenderers } from '../renderer-broadcast'
import type { LocalePreferenceOwner } from './owner'

export const LOCALE_CHANGED_CHANNEL = 'locale:changed'

export const registerLocalePreferenceIpc = (owner: LocalePreferenceOwner): (() => void) => {
  ipcMainHandle('locale:initialize', (_event, request: InitializeLocalePreferenceRequest) =>
    owner.initialize(request?.cachedPreference)
  )
  ipcMainHandle('locale:set-preference', (_event, request: SetLocalePreferenceRequest) =>
    owner.setPreference(request?.preference)
  )
  return owner.subscribe((snapshot) => broadcastToRenderers(LOCALE_CHANGED_CHANNEL, snapshot))
}
