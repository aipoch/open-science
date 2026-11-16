## ✨ 亮点

- **Strict 模式的 Notebook 网络。** 可手动管理的白名单取代了授权询问，只在你选择开启 Strict mode 时生效：请求必须按协议、主机名或 IP、端口与你的规则匹配才允许——不匹配的请求直接拦截。Relaxed mode 仍是默认，保留现有的授权行为。(#4253)
- **研究影片断点续传。** 中断的影片生成会以保留完好状态继续：已完成的场景、旁白、时长与混音在进程重启后复用，对话框显示五步进度中的当前步，并可选择续传或全新生成。(#4290)
- **PDF 往返高保真。** 外部 PDF 可恢复完整的原生图形、图注、表格记录和阅读顺序；翻译后的文档保留原有结构与版式，不再回退到未经验证的排版。(#4300, #4342, #4340, #4334, #4286)
- **更安全的 Windows 授权与更新。** 保护模式下的文件夹授权在保存前即校验；更新、卸载和移交流程恢复更可靠，会说明被何者阻断并保留诊断信息。(#4217, #4305, #4327, #4328, #4337, #4346)
- **服务商目录刷新。** Qwen4 Max Preview 加入位于北京和新加坡的 Bailian Token Plans，带 1M 上下文窗口；官方连接的默认模型也已更新。(#4311, #4301)

## 🚀 新功能

- 可将 Notebook 网络切换为 Strict mode：请求必须按协议、主机名或 IP、端口匹配手动管理的白名单，不匹配的请求会被直接拦截，不再提供授权。规则可按可编辑的逻辑分组管理并带来源标签；内置目标规则仅初始化一次，编辑会持久保存。在依赖该模式前请先检查内置规则，因为被拦截的请求会失败而不是询问。(#4253)
- 可从已验证的检查点恢复中断的研究影片生成：已完成的辅助任务和场景能经受后续故障，旁白与时长缓存独立于播放器构建，影片对话框显示五步进度中的当前步，并提供明确的续传或全新生成选择。(#4290)
- 在保护模式下保存前对 Windows 文件夹授权做只读 ACL 预检：不可用的文件夹会在写入任何授权前连同原因一起被拒绝，Notebook 执行不再因隐蔽的内核启动错误而在事后失败。(#4217)
- 可从位于北京和新加坡的 Bailian Token Plans 中选择 Qwen4 Max Preview：1M 上下文窗口、多模态输入及 low/medium/xhigh 推理档位，通过现有的区域选择器和密钥控制台解析。(#4311)

## 🔧 改进

- 外部 PDF 结构恢复保留完整的图形及其图注、表格记录与单元格，以及缩放文本和页眉附近的原生行内阅读顺序。(#4300, #4342, #4340)
- 翻译后的 PDF 保留原生结构与版式：排版需要经过验证的目标侧证据，无法验证时保留原始内容。(#4334, #4286)
- 会话包导入会报告结果：取消返回非零结果，请求超时标记为未确认并建议重试前先检查，缺失文件或损坏的归档会得到不同的错误码并附日志关联 ID。(#4338)
- 官方服务商连接的默认模型更新为当前的推荐项。(#4301)
- 预览界面适配移动端视口。(#4325)
- 配置的数据根目录可通过已注册的别名访问。(#4306)
- 本地 CLI 保持凭据配置文件完整、容忍控制台失败，并在数据到达期间维持产物下载。(#4298, #4299)

## 🐛 问题修复

- 桌面端失去本地服务时，窗口级恢复界面会阻止工作区交互直到连接恢复，保持草稿挂载并在之后恢复焦点。(#4323)
- Windows 更新与卸载流程将更新安全性与记录清理分离，扫描物理安装资源，移交前回收自有辅助进程，及时取消宿主检查，按进程出生标识而非仅按 PID 识别进程，并保留失败诊断信息。(#4305, #4327, #4328, #4337, #4346)
- 中断的 Windows 内核任务可恢复，PowerShell 的 stderr 重定向不再吞掉原生 Notebook 输出。(#4297, #4295)
- 会话持久化避免删除清理死锁，并将启动时的数据载入与进行中的保存解耦。(#4312, #4314)
- Agent 运行时错误可区分模型服务商故障与 ACP 故障，重新载入的会话在提示词激活前保持受保护，已取消的提示词会中断分类查询。(#4322, #4283, #4289)
- 无关的已保存文件夹授权不再阻塞 Notebook 启动。(#4309)
- 预览在版本检查期间保持内容不偏移。(#4293)
- 直连 SSH 任务取消时对未确认取消尝试的次数加以限制。(#4313)
- 浅色与深色界面的对比度保持一致，包括深色模式头像、回复输入框和主题切换。(#4345, #4339, #4332)
- 桌面端在首次主进程未捕获错误后退出，不再在损坏状态下勉强运行。(#4316)
- 环境审查状态的措辞与其他审查状态明确区分，文献条目接受带灵活空白的 LaTeX 宏包列表。(#4347, #4303)

## 🙏 致谢

- 感谢 [@roxi3906](https://github.com/roxi3906) 实现 Strict 模式的 Notebook 白名单（[#4253](https://github.com/aipoch/open-science/pull/4253)）并修复风险代码展示（[#4318](https://github.com/aipoch/open-science/pull/4318)、[#4282](https://github.com/aipoch/open-science/pull/4282)）。
- 感谢 [@ShuangChenyue](https://github.com/ShuangChenyue) 实现 Windows 文件夹授权预检（[#4217](https://github.com/aipoch/open-science/pull/4217)）。
- 感谢 [@liyeshunag](https://github.com/liyeshunag) 修复 CLI 凭据配置文件（[#4298](https://github.com/aipoch/open-science/pull/4298)）并处理已取消的提示词（[#4289](https://github.com/aipoch/open-science/pull/4289)）。
- 感谢 [@cyj1116](https://github.com/cyj1116) 实现移动端预览界面（[#4325](https://github.com/aipoch/open-science/pull/4325)）并修复产物下载（[#4299](https://github.com/aipoch/open-science/pull/4299)），感谢 [@wen2zhou](https://github.com/wen2zhou) 限制 SSH 取消次数（[#4313](https://github.com/aipoch/open-science/pull/4313)）并保留 PowerShell 输出（[#4295](https://github.com/aipoch/open-science/pull/4295)），感谢 [@liguohhh](https://github.com/liguohhh) 实现重新载入会话的保护（[#4283](https://github.com/aipoch/open-science/pull/4283)），感谢 [@nasus2002](https://github.com/nasus2002) 实现 LaTeX 文献解析（[#4303](https://github.com/aipoch/open-science/pull/4303)），感谢 [@guch96](https://github.com/guch96) 修复会话持久化（[#4314](https://github.com/aipoch/open-science/pull/4314)），感谢 [@daanveer-tech](https://github.com/daanveer-tech) 更新 README（[#4292](https://github.com/aipoch/open-science/pull/4292)、[#4294](https://github.com/aipoch/open-science/pull/4294)、[#4324](https://github.com/aipoch/open-science/pull/4324)）。
