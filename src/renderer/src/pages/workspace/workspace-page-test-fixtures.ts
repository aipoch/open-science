import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import type { ProviderView } from '../../../../shared/settings'

const TEST_PROVIDER: ProviderView = {
  id: 'test-provider',
  type: 'custom',
  name: 'Test Provider',
  supportsImageInput: false,
  models: ['test-model'],
  hasKey: true,
  needsKey: false
}

const setDefaultWorkspaceAgentSettings = (): void => {
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    isLoaded: true,
    activeProviderId: TEST_PROVIDER.id,
    activeModel: TEST_PROVIDER.models[0],
    providers: [TEST_PROVIDER]
  })
}

export { setDefaultWorkspaceAgentSettings }
