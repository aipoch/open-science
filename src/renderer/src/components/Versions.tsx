import { useState } from 'react'
import { useTranslation } from 'react-i18next'

function Versions(): React.JSX.Element {
  const { t } = useTranslation()
  const [versions] = useState(() => window.api.getRuntimeVersions())

  return (
    <ul className="versions">
      <li className="electron-version">
        {t('Electron v')}
        {versions.electron}
      </li>
      <li className="chrome-version">
        {t('Chromium v')}
        {versions.chrome}
      </li>
      <li className="node-version">
        {t('Node v')}
        {versions.node}
      </li>
    </ul>
  )
}

export default Versions
