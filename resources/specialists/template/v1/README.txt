Open Science custom Specialist import guide
===========================================

This ZIP is an editable Specialist template. manifest.json is application-generated metadata; do not edit it. You only fill in specialist.json and can optionally bundle Skills.

One. Package layout

The ZIP root may contain:

  manifest.json   Application metadata. Required. Do not edit.
  specialist.json Your content. Required. The only file to edit.
  README.txt      This guide. Optional; safe to delete.
  LICENSE         Optional.
  skills/         Optional. Bundled Skills.

The recommended layout keeps the package files at the ZIP root. The importer also accepts a ZIP
with exactly one wrapper directory, such as a Finder-created archive, and removes that wrapper
during import. Do not mix root-level files with a wrapper directory. Common archive noise such as
.DS_Store, __MACOSX, and Thumbs.db is ignored automatically.

Two. Fill in specialist.json

specialist.json may contain these six fields; displayName, skillIds, and connectorIds are optional:

  {
    "name": "Research Synthesizer",
    "displayName": "Research Synthesizer",
    "description": "Summarizes and compares research evidence.",
    "systemPrompt": "You synthesize evidence carefully and cite uncertainty.",
    "skillIds": ["document-reader"],
    "connectorIds": ["reference-library"]
  }

  name         Required. After trimming surrounding whitespace, 2-80 characters; letters,
               digits, spaces, hyphens, and underscores only. It must not duplicate an
               existing Specialist name.
  displayName  Optional. Label shown in lists and pickers; defaults to name when omitted.
               When supplied, it must be non-empty and no longer than 80 characters.
  description  Required. Short summary (may be empty). Up to 200 characters.
  systemPrompt Required. Sets the agent identity, duties, and working rules. Up to 32,768 characters.
  skillIds     Optional array of Skill IDs. Invalid or unavailable entries produce warnings
               and are ignored.
  connectorIds Optional array of Connector IDs. Invalid or unavailable entries produce warnings
               and are ignored.

Choose the icon, color, Skills,
Connectors, and full/selected mode on the configuration page after import.

Three. Skill rules

Optional Skills live under skills/<skill-id>/, for example:

  skills/literature-search/SKILL.md

- <skill-id> uses lowercase letters, digits, and hyphens only; it cannot start with "os-" or
  "mcp-". It may use the same ID as a builtin Skill; when present locally, the builtin Skill is
  reused.
- Each Skill directory should contain SKILL.md whose frontmatter name matches the directory ID.
  A missing or mismatched document is skipped with a warning, while the Specialist can still be
  imported.
- If frontmatter includes version, it must be SemVer (for example 0.1.0). An invalid Skill is
  skipped with a warning.
- Scripts, references, and assets go in scripts/, references/, assets/, templates/ subdirectories. Import preview never executes scripts.

Four. Common scenarios

- Instructions only: keep the ZIP free of a skills/ directory.
- Bundle one or more Skills: one dedicated skills/<skill-id>/ directory per Skill. Successfully
  parsed bundled Skill IDs are added to the selected Skills for this import.

Five. Importing in the app

Open Settings → Capabilities → Specialists, choose Add specialist → Import ZIP, select the ZIP. After the preview parses, click Next. The app first saves a disabled Specialist and opens the editing page; choose icon, color, and capabilities, then click Save changes to enable it. Closing Settings or cancelling setup does not discard the import; resume later from the Specialist list.

Six. Troubleshooting

Resolve every error before continuing. Warnings do not block import, but should be reviewed; they
can flag scripts or executable content, invalid optional IDs, unavailable Skills or Connectors, or
missing and malformed bundled Skills.

- JSON invalid: check quotes, commas, and UTF-8 encoding.
- Required file missing: keep manifest.json and specialist.json at the standard ZIP root, or
  inside one wrapper directory.
- Unsupported top-level content: remove files outside the allowed list; do not mix root-level
  files with a wrapper directory.
- Skill document missing / Skill name mismatch: add SKILL.md under each skills/<skill-id>/ and
  make its frontmatter name match the directory name; otherwise that Skill is ignored with a
  warning.
- Skill conflict: an installed Skill has the same ID but different content or version; change the Skill ID or remove the conflict and retry.
- Package/path/size error: remove unsafe paths or shrink the archive. Limits: 50 MB ZIP, 200 MB
  uncompressed, 2,000 files, 25 MB per file, compression ratio no greater than 1,000:1, and
  path depth no greater than 32 levels.

Never put tokens, passwords, Connector server configuration, or other credentials in the package.




Open Science 自定义 Specialist 导入指南
======================================

这个 ZIP 是可编辑的 Specialist 模板。manifest.json 是应用生成的元数据，请勿修改。你只需填写 specialist.json，需要则可以随包加入 Skills。

一、包结构

标准布局下，ZIP 根目录可包含以下内容：

  manifest.json   应用生成的元数据，必填，不要修改
  specialist.json 你填写的内容，必填，唯一需要编辑的文件
  README.txt      本指南，可选，可删除
  LICENSE         可选
  skills/         可选，存放随包携带的 Skill

推荐不要在 ZIP 外再套一层文件夹，也不要添加其他顶层文件。应用也接受只包含一个外层文件夹的 ZIP（例如 Finder 创建的归档），导入时会自动去掉该层；不要同时混用根目录文件和外层文件夹。.DS_Store、__MACOSX、Thumbs.db 等常见归档元数据会被应用自动忽略。

二、填写 specialist.json

specialist.json 只允许下面六个字段；其中 displayName、skillIds 和 connectorIds 可省略：

  {
    "name": "Research Synthesizer",
    "displayName": "Research Synthesizer",
    "description": "Summarizes and compares research evidence.",
    "systemPrompt": "You synthesize evidence carefully and cite uncertainty.",
    "skillIds": ["document-reader"],
    "connectorIds": ["reference-library"]
  }

字段说明：

  name         必填。Specialist 的公开名称，去除首尾空白后须为 2-80 个字符，
               只能由字母、数字、空格、连字符和下划线组成；不能与应用中已有的
               Specialist 名称重复。
  displayName  可选。列表和选择器中显示的名称；省略时使用 name。填写时不能
               为空，最多 80 个字符。
  description  必填。简短说明用途（可留空），最多 200 个字符。
  systemPrompt 必填。设定 agent 身份、职责与工作准则，最多 32,768 个字符。
  skillIds     可选。要引用的 Skill ID 数组；不可用或格式错误的条目会以 warning
               提示并忽略。
  connectorIds 可选。要引用的 Connector ID 数组；不可用或格式错误的条目会以
               warning 提示并忽略。

图标、颜色、Skills、Connectors 以及 full/selected
模式可在导入后的配置页面调整。

三、Skill 规则

可选的 Skill 放在 skills/<skill-id>/ 下，例如：

  skills/literature-search/SKILL.md

- <skill-id> 只能由小写字母、数字和连字符组成，且不能以 "os-" 或 "mcp-" 开头。
  可以使用与内置 Skill 相同的 ID；如果本机存在该内置 Skill，应用会复用它。
- 每个 Skill 目录应包含 SKILL.md，其 frontmatter 中的 name 必须与目录名一致。
  缺失或不匹配时，该 Skill 会被跳过并产生 warning，整体 Specialist 仍可导入。
- 若 frontmatter 写了 version，必须是 SemVer 格式（如 0.1.0）；格式错误的 Skill
  会被跳过并产生 warning。
- Skill 的脚本、参考资料和资源分别放在 scripts/、references/、assets/、templates/ 子目录；导入预览不会执行脚本。

四、常见场景

- 只有 Specialist 指令：保持 ZIP 中没有 skills/ 目录。
- 随包提供一个或多个 Skill：每个 Skill 使用独立的 skills/<skill-id>/ 目录；成功
  解析的 bundled Skill ID 会自动加入本次导入的 selected Skills。

五、在应用中导入

打开 Settings → Capabilities → Specialists，选择 Add specialist → Import ZIP，再选择 ZIP。预览解析成功后点击 Next。应用会先保存一个 disabled Specialist，并进入已有的配置页面；选择图标、颜色和 capabilities 后点击 Save changes 才会启用。此时关闭 Settings 或取消配置不会丢失已导入内容，之后可从列表继续设置。

六、异常处理

所有 error 必须修复后才能继续；warning 不会阻止导入，但应复核。warning 可能来自
脚本或可执行内容、无效的可选 ID、不可用的 Skill/Connector，以及缺失或格式错误的
bundled Skill。

- JSON invalid：检查引号、逗号和 UTF-8 编码。
- Required file missing：确认 manifest.json 和 specialist.json 位于标准 ZIP 根目录，
  或位于唯一的外层文件夹内。
- Unsupported top-level content：删除不在允许列表中的顶层文件；不要同时混用根目录
  文件和外层文件夹。
- Skill document missing / Skill name mismatch：为每个 skills/<skill-id>/ 添加 SKILL.md，
  并让 frontmatter 的 name 与目录名一致；否则该 Skill 会被 warning 忽略。
- Skill conflict：目标应用已有同 ID 但内容或版本不同的 Skill；修改 Skill ID 或删除冲突后重试。
- Package/path/size error：移除不安全路径或缩小包。ZIP 最大 50 MB，解压后最大 200 MB，
  最多 2,000 个文件，单文件最大 25 MB，单条目压缩比不得超过 1,000:1，路径深度不得
  超过 32 层。

包中不要保存 token、密码、Connector server 配置或其他凭证。
