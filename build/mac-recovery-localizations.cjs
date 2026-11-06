/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs')
const path = require('node:path')
const keys = [
  'Quit Open-Science',
  'The update could not be completed.',
  'Retry',
  'Copy diagnostics',
  'Quit'
]
const translations = {
  de: [
    'Open-Science beenden',
    'Das Update konnte nicht abgeschlossen werden.',
    'Erneut versuchen',
    'Diagnose kopieren',
    'Beenden'
  ],
  es: [
    'Salir de Open-Science',
    'No se pudo completar la actualización.',
    'Reintentar',
    'Copiar diagnóstico',
    'Salir'
  ],
  fr: [
    'Quitter Open-Science',
    'La mise à jour n’a pas pu être terminée.',
    'Réessayer',
    'Copier le diagnostic',
    'Quitter'
  ],
  'zh-Hans': ['退出 Open-Science', '无法完成更新。', '重试', '复制诊断信息', '退出'],
  'zh-Hant': ['結束 Open-Science', '無法完成更新。', '重試', '複製診斷資訊', '結束'],
  ja: ['Open-Science を終了', '更新を完了できませんでした。', '再試行', '診断情報をコピー', '終了'],
  ko: [
    'Open-Science 종료',
    '업데이트를 완료하지 못했습니다.',
    '다시 시도',
    '진단 정보 복사',
    '종료'
  ],
  ru: [
    'Завершить Open-Science',
    'Не удалось завершить обновление.',
    'Повторить',
    'Копировать диагностику',
    'Выход'
  ]
}

const failureCopy = {
  'The original update package could not be obtained or checked. Check the network connection, then retry. If the problem continues, copy diagnostics for support.':
    {
      de: 'Das ursprüngliche Updatepaket konnte nicht abgerufen oder geprüft werden. Prüfen Sie die Netzwerkverbindung und versuchen Sie es erneut. Kopieren Sie bei anhaltenden Problemen die Diagnose für den Support.',
      es: 'No se pudo obtener o comprobar el paquete de actualización original. Compruebe la conexión de red y vuelva a intentarlo. Si el problema persiste, copie el diagnóstico para solicitar asistencia.',
      fr: 'Le paquet de mise à jour d’origine n’a pas pu être obtenu ou vérifié. Vérifiez la connexion réseau, puis réessayez. Si le problème persiste, copiez le diagnostic pour l’assistance.',
      'zh-Hans':
        '无法获取或校验原更新包。请检查网络连接后重试。若问题仍然存在，请复制诊断信息以联系支持。',
      'zh-Hant':
        '無法取得或驗證原更新套件。請檢查網路連線後重試。若問題持續發生，請複製診斷資訊供支援人員查閱。',
      ja: '元の更新パッケージを取得または検証できませんでした。ネットワーク接続を確認して再試行してください。問題が続く場合は、サポート用に診断情報をコピーしてください。',
      ko: '원래 업데이트 패키지를 가져오거나 확인하지 못했습니다. 네트워크 연결을 확인한 후 다시 시도하십시오. 문제가 계속되면 지원을 위해 진단 정보를 복사하십시오.',
      ru: 'Не удалось получить или проверить исходный пакет обновления. Проверьте сетевое подключение и повторите попытку. Если проблема сохранится, скопируйте диагностику для службы поддержки.'
    },
  'The application files could not be prepared. Check free disk space and whether this account can write to the application folder, then retry.':
    {
      de: 'Die Anwendungsdateien konnten nicht vorbereitet werden. Prüfen Sie den freien Speicherplatz und die Schreibberechtigung dieses Kontos für den Anwendungsordner und versuchen Sie es erneut.',
      es: 'No se pudieron preparar los archivos de la aplicación. Compruebe el espacio libre en disco y que esta cuenta pueda escribir en la carpeta de la aplicación; después, vuelva a intentarlo.',
      fr: 'Les fichiers de l’application n’ont pas pu être préparés. Vérifiez l’espace disque disponible et les droits d’écriture de ce compte dans le dossier de l’application, puis réessayez.',
      'zh-Hans':
        '无法准备应用文件。请检查磁盘可用空间，以及当前账户是否能写入应用文件夹，然后重试。',
      'zh-Hant':
        '無法準備應用程式檔案。請檢查磁碟可用空間，以及目前帳號是否能寫入應用程式資料夾，然後重試。',
      ja: 'アプリのファイルを準備できませんでした。ディスクの空き容量と、このアカウントでアプリのフォルダーに書き込めるかを確認してから再試行してください。',
      ko: '애플리케이션 파일을 준비하지 못했습니다. 디스크 여유 공간과 현재 계정의 애플리케이션 폴더 쓰기 권한을 확인한 후 다시 시도하십시오.',
      ru: 'Не удалось подготовить файлы приложения. Проверьте свободное место на диске и возможность записи в папку приложения от имени этой учётной записи, затем повторите попытку.'
    },
  'The application could not safely prepare the update. Quit other copies normally, then retry, or copy diagnostics for support.':
    {
      de: 'Die Anwendung konnte das Update nicht sicher vorbereiten. Beenden Sie andere Kopien regulär und versuchen Sie es erneut oder kopieren Sie die Diagnose für den Support.',
      es: 'La aplicación no pudo preparar la actualización de forma segura. Cierre las otras copias normalmente y vuelva a intentarlo, o copie el diagnóstico para solicitar asistencia.',
      fr: 'L’application n’a pas pu préparer la mise à jour en toute sécurité. Quittez normalement les autres copies, puis réessayez, ou copiez le diagnostic pour l’assistance.',
      'zh-Hans': '应用无法安全地准备更新。请正常退出其他副本后重试，或复制诊断信息以联系支持。',
      'zh-Hant':
        '應用程式無法安全地準備更新。請正常結束其他副本後重試，或複製診斷資訊供支援人員查閱。',
      ja: 'アプリの更新を安全に準備できませんでした。ほかのコピーを通常の方法で終了して再試行するか、サポート用に診断情報をコピーしてください。',
      ko: '애플리케이션이 업데이트를 안전하게 준비하지 못했습니다. 다른 복사본을 정상적으로 종료한 후 다시 시도하거나 지원을 위해 진단 정보를 복사하십시오.',
      ru: 'Приложению не удалось безопасно подготовить обновление. Завершите другие копии обычным способом и повторите попытку или скопируйте диагностику для службы поддержки.'
    },
  'The original update or application identity could not be verified. The update remains protected. Copy diagnostics for support.':
    {
      de: 'Das ursprüngliche Update oder die Identität der Anwendung konnte nicht verifiziert werden. Das Update bleibt geschützt. Kopieren Sie die Diagnose für den Support.',
      es: 'No se pudo verificar la actualización original o la identidad de la aplicación. La actualización permanece protegida. Copie el diagnóstico para solicitar asistencia.',
      fr: 'La mise à jour d’origine ou l’identité de l’application n’a pas pu être vérifiée. La mise à jour reste protégée. Copiez le diagnostic pour l’assistance.',
      'zh-Hans': '无法核验原更新或应用身份。更新保护仍然有效。请复制诊断信息以联系支持。',
      'zh-Hant': '無法驗證原更新或應用程式身分。更新保護仍然有效。請複製診斷資訊供支援人員查閱。',
      ja: '元の更新またはアプリの識別情報を検証できませんでした。更新の保護は維持されています。サポート用に診断情報をコピーしてください。',
      ko: '원래 업데이트 또는 애플리케이션의 신원을 확인하지 못했습니다. 업데이트 보호가 유지됩니다. 지원을 위해 진단 정보를 복사하십시오.',
      ru: 'Не удалось проверить исходное обновление или идентичность приложения. Защита обновления сохраняется. Скопируйте диагностику для службы поддержки.'
    },
  'The application could not be opened. Retry. If it still cannot start, copy diagnostics for support.':
    {
      de: 'Die Anwendung konnte nicht geöffnet werden. Versuchen Sie es erneut. Wenn sie weiterhin nicht startet, kopieren Sie die Diagnose für den Support.',
      es: 'No se pudo abrir la aplicación. Vuelva a intentarlo. Si sigue sin iniciarse, copie el diagnóstico para solicitar asistencia.',
      fr: 'L’application n’a pas pu être ouverte. Réessayez. Si elle ne démarre toujours pas, copiez le diagnostic pour l’assistance.',
      'zh-Hans': '无法打开应用。请重试。若仍无法启动，请复制诊断信息以联系支持。',
      'zh-Hant': '無法開啟應用程式。請重試。若仍無法啟動，請複製診斷資訊供支援人員查閱。',
      ja: 'アプリを開けませんでした。再試行してください。起動できない場合は、サポート用に診断情報をコピーしてください。',
      ko: '애플리케이션을 열지 못했습니다. 다시 시도하십시오. 계속 시작되지 않으면 지원을 위해 진단 정보를 복사하십시오.',
      ru: 'Не удалось открыть приложение. Повторите попытку. Если оно по-прежнему не запускается, скопируйте диагностику для службы поддержки.'
    }
}

// This is a native AppKit bootstrap: its strings load before Electron/i18next can run.
module.exports = function writeRecoveryLocalizations(resources) {
  for (const [locale, values] of Object.entries({ en: keys, ...translations })) {
    const directory = path.join(resources, `${locale}.lproj`)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(
      path.join(directory, 'Localizable.strings'),
      keys
        .map((key, index) => `${JSON.stringify(key)} = ${JSON.stringify(values[index])};`)
        .concat(
          Object.entries(failureCopy).map(
            ([key, copy]) =>
              `${JSON.stringify(key)} = ${JSON.stringify(locale === 'en' ? key : copy[locale])};`
          )
        )
        .join('\n') + '\n'
    )
  }
}
