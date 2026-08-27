# Localization Glossary

The binding reference for the `common`, `native`, and `renderer` namespaces in
`src/shared/i18n/locales/es.json`, `fr.json`, `ja.json`, `ko.json`, `pt-BR.json`, `ru.json`,
`zh-Hans.json`, and
`zh-Hant.json`. There is no English catalog: **the key is the English source text**.
`t('Data folder not found')` renders that sentence verbatim in English and looks it up in the
localized catalogs, so a missing translation falls back to correct English rather than a raw key
path. This keeps the English legible in a code diff, which is where copy actually gets reviewed.

Traditional Chinese is a **separate translation**, not a character conversion of Simplified. The
software vocabulary genuinely differs (`file` is 文件 in Simplified but 檔案 in Traditional, where
文件 means _document_), so running a converter over `zh-Hans` produces wrong copy. Translate from the
English key and consult the tables below. Spanish, French, Japanese, Korean, Brazilian Portuguese,
and Russian are also translated independently from the English key; do not derive them from another
catalog.

## Key conventions

Catalog keys are flat inside each of the three namespace objects. `keySeparator` and `nsSeparator`
are off, so the periods and colons inside an English sentence stay part of the key.

- **Editing English copy changes the key.** Rename the matching catalog entries in the same commit,
  or the translation is stranded and the UI silently falls back to English. `resources.test.ts`
  fails on any entry whose key no longer appears in the source.
- **Plurals**: the key is the English _plural_ form and the call site passes the singular:
  `t('{{count}} files selected', { count, defaultValue_one: '{{count}} file selected' })`. Chinese,
  Japanese, and Korean have one plural category, so their entries take the `_other` suffix and `_one`
  entries are rejected. French, Brazilian Portuguese, and Spanish have `one`, `many`, and `other`
  categories, so `_one`, `_many`, and `_other` entries are required. The `_many` category is selected
  for values such as 1,000,000 and can usually reuse the `_other` translation. Russian requires the
  complete `_one`, `_few`, `_many`, and `_other` set for every counted key.
- **Context** disambiguates two different meanings that share one English string — `t('Compute', {
context: 'noun' })` keys `Compute_noun`. Only translated catalogs carry the suffixed entry;
  English ignores context and renders the base key.
- **Placeholders and `<tag>` markers must survive translation.** A dropped `{{name}}` renders a
  blank where a value belongs, and a dropped tag makes `Trans` discard the wrapped element. Never
  name a `Trans` tag after a void HTML element (`<link>`, `<br>`, `<img>`): the parser self-closes
  it and the label escapes the wrapper, producing a link nobody can click. Use `<a1>` or `<guide>`.
- **Modules outside the renderer** (`src/shared/**`) have no `t()` access, so they carry the English
  text and the renderer resolves it. They are scanned by the same guards.

## Kept in English

Never translated, in any catalog:

`Open Science` (product name), `Claude`, `Codex`, `opencode`, `Notebook`, `MCP`, `ACP`, `API`,
`CLI`, `SSH`, `GitHub`, `Star`, `Discord`, `Python`, `Jupyter`, and all model names.

- `Notebook` is a fixed Open Science feature name. Retaining it also avoids the paper-notebook
  reading of 笔记本 / 筆記本.
- Translate generic `Skill` and `Agent` prose according to the core table below. Keep exact file
  names, commands, paths, protocol identifiers, and code spans unchanged, including `SKILL.md`,
  `.skill`, `skill://`, `skills/`, `.agents/skills`, `AGENTS.md`, `ssh-agent`, and `setup-token`.
- Translate `token` by meaning: Spanish and Brazilian Portuguese retain token, while French uses
  jeton for both meanings; model input, output, context,
  and usage counts use 词元 / 詞元 / トークン / 토큰 / токен; authentication credentials use 令牌 /
  權杖 / トークン / 토큰 / токен. API field names such as `max_tokens` remain unchanged.
- The `Open Science` name is fixed by `docs/design.md`, but the home tagline beneath it **is**
  translated.

## Core domain nouns

| en                 | fr                        | pt-BR                   | ja                         | ko                  | ru                   | zh-Hans    | zh-Hant    |
| ------------------ | ------------------------- | ----------------------- | -------------------------- | ------------------- | -------------------- | ---------- | ---------- |
| project            | projet                    | projeto                 | プロジェクト               | 프로젝트            | проект               | 项目       | 專案       |
| session            | session                   | sessão                  | セッション                 | 세션                | сессия               | 会话       | 會話       |
| conversation       | conversation              | conversa                | 会話                       | 대화                | диалог               | 对话       | 對話       |
| workspace          | espace de travail         | espaço de trabalho      | ワークスペース             | 워크스페이스        | рабочее пространство | 工作区     | 工作區     |
| message            | message                   | mensagem                | メッセージ                 | 메시지              | сообщение            | 消息       | 訊息       |
| task               | tâche                     | tarefa                  | タスク                     | 작업                | задача               | 任务       | 任務       |
| run                | exécution                 | execução                | 実行                       | 실행                | выполнение           | 运行       | 執行       |
| turn               | tour                      | turno                   | ターン                     | 턴                  | ход                  | 轮次       | 輪次       |
| agent              | agent                     | agente                  | エージェント               | 에이전트            | агент                | 智能体     | 智能體     |
| subagent           | sous-agent                | subagente               | サブエージェント           | 서브에이전트        | субагент             | 子智能体   | 子智能體   |
| agent framework    | framework d'agents        | framework de agentes    | エージェントフレームワーク | 에이전트 프레임워크 | фреймворк агентов    | 智能体框架 | 智能體框架 |
| model              | modèle                    | modelo                  | モデル                     | 모델                | модель               | 模型       | 模型       |
| provider           | fournisseur               | provedor                | プロバイダー               | 모델 제공업체       | поставщик моделей    | 模型服务商 | 模型服務商 |
| subscription       | abonnement                | assinatura              | サブスクリプション         | 구독                | подписка             | 订阅       | 訂閱       |
| skill              | compétence                | habilidade              | スキル                     | 스킬                | навык                | 技能       | 技能       |
| specialist         | spécialiste               | especialista            | スペシャリスト             | 스페셜리스트        | специалист           | 专家       | 專家       |
| marketplace        | place de marché           | Marketplace             | マーケットプレイス         | 마켓플레이스        | маркетплейс          | 市场       | 市集       |
| connector          | connecteur                | conector                | コネクタ                   | 커넥터              | коннектор            | 连接器     | 連接器     |
| shell              | terminal                  | linha de comando        | シェル                     | 셸                  | командная строка     | 命令行     | 命令列     |
| main agent         | agent principal           | agente principal        | メインエージェント         | 메인 에이전트       | главный агент        | 主智能体   | 主智能體   |
| token (model)      | jeton                     | token                   | トークン                   | 토큰                | токен                | 词元       | 詞元       |
| token (credential) | jeton                     | token                   | トークン                   | 토큰                | токен                | 令牌       | 權杖       |
| kernel             | noyau                     | núcleo                  | カーネル                   | 커널                | ядро                 | 内核       | 核心       |
| artifact           | artefact                  | artefato                | アーティファクト           | 아티팩트            | артефакт             | 产物       | 產物       |
| activity group     | groupe d'activités        | grupo de atividades     | アクティビティグループ     | 활동 그룹           | группа действий      | 活动分组   | 活動分組   |
| tool               | outil                     | ferramenta              | ツール                     | 도구                | инструмент           | 工具       | 工具       |
| compute host       | hôte de calcul            | host de computação      | コンピュートホスト         | 컴퓨팅 호스트       | вычислительный узел  | 计算主机   | 運算主機   |
| runtime            | environnement d'exécution | ambiente de execução    | ランタイム                 | 런타임              | среда выполнения     | 运行时     | 執行環境   |
| environment        | environnement             | ambiente                | 環境                       | 환경                | окружение            | 环境       | 環境       |
| preview            | aperçu                    | visualização            | プレビュー                 | 미리보기            | предпросмотр         | 预览       | 預覽       |
| reasoning effort   | effort de raisonnement    | esforço de raciocínio   | 推論の強度                 | 추론 강도           | глубина рассуждений  | 推理强度   | 推理強度   |
| context            | contexte                  | contexto                | コンテキスト               | 컨텍스트            | контекст             | 上下文     | 上下文     |
| context compaction | compactage du contexte    | compactação de contexto | コンテキスト圧縮           | 컨텍스트 압축       | сжатие контекста     | 上下文压缩 | 上下文壓縮 |

Translate generic Open Science roles, surfaces, and domain nouns according to the table. Keep exact
third-party names and technical identifiers, including `Claude Connectors Directory`,
`Specialist Marketplace protocol`, `specialist.json`, and package filenames.

## Simplified / Traditional divergences

The highest-risk table. A character converter gets most of the Chinese pairs wrong; the Japanese,
Korean, and Russian columns record their corresponding independent translations.

| en                 | ja           | ko          | ru                      | zh-Hans | zh-Hant  |
| ------------------ | ------------ | ----------- | ----------------------- | ------- | -------- |
| file               | ファイル     | 파일        | файл                    | 文件    | 檔案     |
| document           | ドキュメント | 문서        | документ                | 文档    | 文件     |
| folder             | フォルダー   | 폴더        | папка                   | 文件夹  | 資料夾   |
| data               | データ       | 데이터      | данные                  | 数据    | 資料     |
| information        | 情報         | 정보        | информация              | 信息    | 資訊     |
| software           | ソフトウェア | 소프트웨어  | программное обеспечение | 软件    | 軟體     |
| program            | プログラム   | 프로그램    | программа               | 程序    | 程式     |
| default            | デフォルト   | 기본값      | по умолчанию            | 默认    | 預設     |
| settings           | 設定         | 설정        | настройки               | 设置    | 設定     |
| network            | ネットワーク | 네트워크    | сеть                    | 网络    | 網路     |
| cache              | キャッシュ   | 캐시        | кэш                     | 缓存    | 快取     |
| process            | プロセス     | 프로세스    | процесс                 | 进程    | 行程     |
| thread             | スレッド     | 스레드      | поток                   | 线程    | 執行緒   |
| queue              | キュー       | 대기열      | очередь                 | 队列    | 佇列     |
| storage            | ストレージ   | 저장소      | хранилище               | 存储    | 儲存     |
| credential         | 認証情報     | 자격 증명   | учётные данные          | 凭据    | 憑證     |
| log                | ログ         | 로그        | журнал                  | 日志    | 記錄檔   |
| mirror             | ミラー       | 미러        | зеркало                 | 镜像源  | 鏡像來源 |
| tray               | トレイ       | 트레이      | трей                    | 托盘    | 系統匣   |
| bookmark           | ブックマーク | 북마크      | закладка                | 书签    | 書籤     |
| archive (verb)     | アーカイブ   | 보관        | архивировать            | 归档    | 封存     |
| approve / approval | 許可 / 承認  | 허용 / 승인 | разрешить / разрешение  | 批准    | 核准     |

Note the `file` / `document` inversion: Traditional 文件 means what Simplified calls 文档. Getting
this pair backwards is the single most common failure in Simplified-to-Traditional conversion.

## Actions and states

| en                   | fr                             | pt-BR                    | ja                              | ko                   | ru                             | zh-Hans        | zh-Hant        |
| -------------------- | ------------------------------ | ------------------------ | ------------------------------- | -------------------- | ------------------------------ | -------------- | -------------- |
| create / new         | créer / nouveau                | criar / novo             | 作成 / 新規                     | 만들기 / 새로 만들기 | создать / новый                | 新建           | 新增           |
| edit                 | modifier                       | editar                   | 編集                            | 편집                 | изменить                       | 编辑           | 編輯           |
| rename               | renommer                       | renomear                 | 名前を変更                      | 이름 바꾸기          | переименовать                  | 重命名         | 重新命名       |
| delete               | supprimer                      | excluir                  | 削除                            | 삭제                 | удалить                        | 删除           | 刪除           |
| retry                | réessayer                      | tentar novamente         | 再試行                          | 다시 시도            | повторить                      | 重试           | 重試           |
| resume               | reprendre                      | retomar                  | 再開                            | 재개                 | продолжить                     | 继续           | 繼續           |
| stop                 | arrêter                        | parar                    | 停止                            | 중지                 | остановить                     | 停止           | 停止           |
| cancel               | annuler                        | cancelar                 | キャンセル                      | 취소                 | отменить                       | 取消           | 取消           |
| install / uninstall  | installer / désinstaller       | instalar / desinstalar   | インストール / アンインストール | 설치 / 제거          | установить / удалить           | 安装 / 卸载    | 安裝 / 移除    |
| validate             | valider                        | validar                  | 検証                            | 검증                 | проверить                      | 验证           | 驗證           |
| import / export      | importer / exporter            | importar / exportar      | インポート / エクスポート       | 가져오기 / 내보내기  | импортировать / экспортировать | 导入 / 导出    | 匯入 / 匯出    |
| upload / download    | téléverser / télécharger       | enviar / baixar          | アップロード / ダウンロード     | 업로드 / 다운로드    | загрузить / скачать            | 上传 / 下载    | 上傳 / 下載    |
| reveal in folder     | afficher dans le dossier       | mostrar na pasta         | フォルダーに表示                | 폴더에 표시          | показать в папке               | 在文件夹中显示 | 在資料夾中顯示 |
| minimize to tray     | réduire dans la zone de notif. | minimizar para a bandeja | トレイに最小化                  | 트레이로 최소화      | свернуть в трей                | 最小化到托盘   | 最小化至系統匣 |
| idle                 | inactif                        | ocioso                   | 待機中                          | 대기 중              | ожидание                       | 空闲           | 閒置           |
| running              | en cours                       | em execução              | 実行中                          | 실행 중              | выполняется                    | 运行中         | 執行中         |
| waiting for approval | en attente d'approbation       | aguardando aprovação     | 承認待ち                        | 승인 대기 중         | ожидает разрешения             | 等待批准       | 等待核准       |
| failed               | échec                          | falha                    | 失敗                            | 실패                 | ошибка                         | 失败           | 失敗           |
| completed            | terminé                        | concluído                | 完了                            | 완료                 | завершено                      | 已完成         | 已完成         |
| pending              | en attente                     | pendente                 | 保留中                          | 대기 중              | ожидает обработки              | 待处理         | 待處理         |

## Interface chrome

| en                    | fr                         | pt-BR                          | ja                         | ko                     | ru                           | zh-Hans            | zh-Hant            |
| --------------------- | -------------------------- | ------------------------------ | -------------------------- | ---------------------- | ---------------------------- | ------------------ | ------------------ |
| Home                  | Accueil                    | Início                         | ホーム                     | 홈                     | Главная                      | 首页               | 首頁               |
| Onboarding            | Configuration initiale     | Configuração inicial           | 初期設定                   | 초기 설정              | Настройка                    | 初始设置           | 初始設定           |
| General               | Général                    | Geral                          | 一般                       | 일반                   | Общие                        | 通用               | 一般               |
| Appearance            | Apparence                  | Aparência                      | 外観                       | 외관                   | Внешний вид                  | 外观               | 外觀               |
| Theme                 | Thème                      | Tema                           | テーマ                     | 테마                   | Тема                         | 主题               | 主題               |
| System / Light / Dark | Système / Clair / Sombre   | Sistema / Claro / Escuro       | システム / ライト / ダーク | 시스템 / 라이트 / 다크 | Системная / Светлая / Тёмная | 系统 / 浅色 / 深色 | 系統 / 淺色 / 深色 |
| Language              | Langue                     | Idioma                         | 言語                       | 언어                   | Язык                         | 语言               | 語言               |
| Notifications         | Notifications              | Notificações                   | 通知                       | 알림                   | Уведомления                  | 通知               | 通知               |
| Diagnostics           | Diagnostics                | Diagnósticos                   | 診断                       | 진단                   | Диагностика                  | 诊断               | 診斷               |
| Permissions           | Autorisations              | Permissões                     | 権限                       | 권한                   | Разрешения                   | 权限               | 權限               |
| Data root             | Racine des données         | Raiz de dados                  | データルート               | 데이터 루트            | Корневая папка данных        | 数据目录           | 資料目錄           |
| Command line tool     | Outil en ligne de commande | Ferramenta de linha de comando | コマンドラインツール       | 명령줄 도구            | Инструмент командной строки  | 命令行工具         | 命令列工具         |

## Spanish terminology

Spanish is translated directly from the English source key. These terms are binding for prose in
the `common`, `native`, and `renderer` namespaces:

| en               | es                                              |
| ---------------- | ----------------------------------------------- |
| project          | proyecto                                        |
| session          | sesión                                          |
| workspace        | espacio de trabajo                              |
| agent            | agente                                          |
| subagent         | subagente                                       |
| agent framework  | framework de agentes                            |
| main agent       | agente principal                                |
| model            | modelo                                          |
| main model       | modelo principal                                |
| provider         | proveedor                                       |
| skill            | habilidad                                       |
| specialist       | especialista                                    |
| marketplace      | mercado                                         |
| connector        | conector                                        |
| shell            | línea de comandos                               |
| token            | token                                           |
| runtime          | entorno de ejecución                            |
| reasoning effort | esfuerzo de razonamiento                        |
| running          | en ejecución                                    |
| failed (clause)  | falló                                           |
| failed (status)  | error / fallido / fallida, according to context |
| resume           | reanudar                                        |
| light (theme)    | claro                                           |
| prompt           | prompt                                          |
| system prompt    | prompt del sistema                              |
| Jupyter kernel   | kernel                                          |
| computer         | equipo                                          |
| Compute Host     | host de cálculo                                 |
| endpoint         | endpoint                                        |

## Style rules

- Full-width punctuation (`，。：；？`) in Chinese prose. Code, paths, and commands keep their
  original half-width characters.
- Japanese prose uses Japanese punctuation. Retained Latin product terms stay unchanged and take
  surrounding spaces where they improve readability.
- Korean prose uses standard Korean spacing and punctuation. Retained Latin product terms stay
  unchanged and take surrounding spaces where they improve readability.
- Russian prose uses sentence case and standard Russian punctuation. Use `ё` where it is the natural
  spelling, and keep retained Latin product terms unchanged. Use concise native UI phrasing:
  `предпросмотр` (not `предварительный просмотр`), `API-ключ`, and infinitives for button actions.
  Translate permission approval as `разрешение`; reserve `утвердить` / `утверждение` for execution
  Plans. Avoid literal calques and unnecessary loanwords such as `опционально`, `кастомный`, and
  `ревью` when established Russian UI terms are available.
- French prose uses French punctuation and sentence case. Retained product names and technical
  identifiers keep their original spelling.
- Brazilian Portuguese prose uses Brazilian spelling and sentence case. Use `você`, `arquivo`,
  `excluir`, `salvar`, and `habilidade` consistently; retain `Marketplace`, product names, and
  technical identifiers exactly.
  Translate permission grants as `permissões`, never the financial sense `subsídios`.
- Spanish uses neutral international wording. Prefer `equipo` over the regional `computadora` or
  `ordenador`, `archivo` over `fichero`, and established community terms such as `prompt`, `kernel`,
  `endpoint`, `framework` and `host` when translating them would make the interface less precise.
  Use formal `usted` or impersonal constructions consistently. Button and menu commands use the
  infinitive; instructions in complete sentences use the formal imperative. Use sentence case,
  `…` for ellipses and `p. ej.,` for examples. Keep product names, configuration fields, protocol
  labels and other technical identifiers unchanged, including `Claude Agent`, `MCP Registry`,
  `Streamable HTTP`, `User`, `Port`, `command`, `url`, `PATH` and `Star` on GitHub.
- One half-width space between Chinese and Latin script (`使用 Claude 模型`). No space between a
  number and a Chinese unit that reads as one word (`5 分钟` takes the space; `12k` is not split).
- Second person is 你, never 您 — it matches the supportive, non-authoritative tone `docs/design.md`
  asks for.
- Short labels (buttons, table headers, menu items) take no trailing period. Full sentences do.
- No exclamation points, per `docs/design.md`.
- Don't pad imperatives with 请. `Check the network` is 检查网络连接, not 请检查网络连接.
- Language names in the language picker are written in their own language and never translated:
  `English`, `Español`, `Français`, `Português (Brasil)`, `日本語`, `한국어`, `Русский`, `简体中文`,
  `繁體中文`. Only the `System`
  option follows the interface language.
