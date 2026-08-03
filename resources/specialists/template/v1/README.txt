Open Science 自定义 Specialist 导入指南
======================================

这个 ZIP 是可直接编辑的 Specialist 模板。manifest.json 是应用生成的元数据，请不要修改。你只需要填写 specialist.json，并可按需加入 Skills。

一、包结构

ZIP 根目录必须包含：

  manifest.json
  specialist.json
  README.txt

可选 Skill 放在 skills/<skill-id>/ 下。每个 Skill 目录必须包含 SKILL.md；SKILL.md frontmatter 的 name 必须与目录名完全一致。例如：

  skills/literature-search/SKILL.md

不要在 ZIP 外再套一层文件夹，也不要添加 README.md 或其他顶层文件。

二、填写 specialist.json

只允许以下字段：

  {
    "name": "Research Synthesizer",
    "displayName": "Research Synthesizer",
    "description": "Summarizes and compares research evidence.",
    "systemPrompt": "You synthesize evidence carefully and cite uncertainty."
  }

displayName 可省略。不要填写 id、version、iconKey、colorKey、enabled、capabilityMode、fullAccess 或 selectedCapabilities。图标、颜色和 capabilities 会在导入后的配置页面选择。

三、常见场景

- 只有 Specialist 指令：保持 ZIP 中没有 skills/ 目录。
- 随包提供一个或多个 Skill：每个 Skill 使用独立的 skills/<skill-id>/ 目录。
- Skill 需要脚本、参考资料或资源：分别放在 scripts/、references/、assets/ 或 templates/ 子目录。导入预览不会执行脚本。

四、在应用中导入

打开 Settings → Capabilities → Specialists，选择 Add specialist → Import ZIP，再选择 ZIP。预览解析成功后点击 Next。应用会立即保存一个 disabled Specialist，并进入已有配置页面。选择图标、颜色和 capabilities 后点击 Save changes 才会启用。若关闭 Settings 或取消配置，已导入内容不会丢失；之后可从列表继续设置。

五、异常处理

- JSON invalid：检查引号、逗号和 UTF-8 编码。
- Required file missing：确认 manifest.json 和 specialist.json 位于 ZIP 根目录。
- Unsupported top-level content：删除多余顶层文件，或去掉外层目录后重新压缩。
- Skill document missing：为每个 skills/<skill-id>/ 添加 SKILL.md。
- Skill name mismatch：让 SKILL.md frontmatter 的 name 与目录名完全一致。
- Skill conflict：目标应用已有同 ID 但内容或版本不同的 Skill；修改 Skill ID 或删除冲突后重试。
- Package/path/size error：移除不安全路径或缩小包。ZIP 最大 50 MB，解压后最大 200 MB，最多 2,000 个文件，单文件最大 25 MB。

所有 error 必须修复后才能继续。warning 用于提示脚本等需要复核的内容。包中不要保存 token、密码、Connector server 配置或其他凭证。


Open Science custom Specialist import guide
===========================================

This ZIP is an editable Specialist template. manifest.json contains application-generated metadata and should not be edited. Fill in specialist.json and optionally add Skills.

The ZIP root must contain manifest.json, specialist.json, and README.txt. Put every bundled Skill under skills/<skill-id>/ with a SKILL.md whose frontmatter name exactly matches <skill-id>. Do not wrap the files in an extra directory or add README.md.

specialist.json may contain only name, optional displayName, description, and systemPrompt. Identity, version, icon, color, enabled state, and capabilities are application-owned and must not be included.

In Open Science, open Settings → Capabilities → Specialists, choose Add specialist → Import ZIP, select the ZIP, review diagnostics, and click Next. The application immediately saves the imported Specialist as disabled and opens the existing configuration page. Choose its icon, color, Skills, and Connectors, then click Save changes to enable it. Closing Settings or cancelling configuration does not discard the imported content; continue setup later from the Specialist list.

Common errors include invalid JSON, required files outside the ZIP root, an extra wrapper directory, a missing SKILL.md, a frontmatter name that differs from its Skill directory, an installed Skill ID conflict, unsafe paths, and archive limits. Resolve every error and import again. Preview never executes scripts. Never include tokens, passwords, Connector server configuration, or other credentials.
