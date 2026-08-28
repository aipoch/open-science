## ✨ Destaques

- **Framework de agente CodeBuddy.** O CodeBuddy passa a ser o quarto framework de agente disponível, ao lado de Claude Code, OpenCode e Codex. Ele é instalado e gerenciado em Configurações, não exige um login separado, usa os provedores de modelos já configurados e encaminha habilidades, Notebooks e conectores pelo mesmo ambiente de execução controlado pelo aplicativo. (#1831, #1849)
- **Anotações.** Selecione um texto na conversa, na atividade das ferramentas ou na visualização de arquivos — ou marque um ponto em uma imagem — e envie esse conteúdo ao agente como contexto. As anotações persistem entre reinicializações, são preservadas ao editar e reenviar e aparecem como cards na conversa. (#1815, #1821, #1826, #1837)
- **Catálogos expandidos do OpenCode.** O OpenCode Go passa a oferecer 21 modelos, e o OpenCode Zen, 40. Os catálogos incluem as famílias mais recentes de Claude, GPT, Grok, GLM, DeepSeek, Kimi e Qwen, com metadados de endpoint, janela de contexto e raciocínio por modelo. (#1807)
- **Marcadores de alteração da configuração.** Quando o framework, o modelo ou o nível de raciocínio de uma sessão muda entre interações, a conversa exibe um divisor discreto com a nova configuração. Assim, fica claro por que as respostas seguintes podem ser diferentes. (#1825, #1833)

## 🚀 Novos recursos

- **Framework de agente CodeBuddy** — ambiente de execução sobre ACP gerenciado pelo aplicativo, com versão fixada e sem necessidade de login; adapta o direcionamento da sessão, as alterações de modelo e nível de raciocínio, a compactação, a entrada de imagens e o uso por chamada, enquanto habilidades, Notebooks e conectores continuam no roteamento controlado pelo aplicativo. (#1831, #1849)
- **Anotações em textos e imagens** — faça anotações em seleções na conversa, na atividade, em solicitações estruturadas e na visualização de arquivos; cada anotação mantém sua origem, pode ser exibida sob demanda, sobrevive a edições e reenvios e é serializada nas mensagens do agente e das conversas laterais. (#1815, #1821, #1826, #1837)
- **Catálogos de modelos expandidos do OpenCode Go e do OpenCode Zen**, com substituição de endpoint por modelo para conectar corretamente modelos que usam protocolos diferentes. (#1807)
- **Autenticação SSH por senha no Windows** para hosts de computação remota, com credenciais mantidas no armazenamento seguro do Windows. (#1805)
- **Marcadores de alteração da configuração do agente** na linha do tempo da conversa. (#1825, #1833)
- **As linhas de carregamento de habilidades exibem o documento da habilidade** — ao expandir o carregamento concluído de uma habilidade, suas instruções são renderizadas em Markdown, em vez de JSON bruto. (#1812)
- **Grade de cards do Marketplace de Especialistas**, com chips de filtro para Oficiais, Comunidade e atualizações disponíveis. (#1840)
- **Central de notificações reformulada** — os ícones agora indicam tanto o que aconteceu quanto se o item ainda requer sua atenção, com estados de lido e não lido mais claros e prévias em duas linhas. (#1841)
- **32 novos ícones de avatar para especialistas** nas categorias ciência, pesquisa, funções e engenharia. (#1838)

## 🔧 Melhorias

- As solicitações de permissão do Chromium originadas no renderer agora são negadas por padrão, reduzindo a superfície disponível para código do renderer que tenha sido comprometido. (#1817)
- Os detalhes persistidos da execução de trabalhos de computação remota agora são protegidos pelo armazenamento seguro do sistema operacional, com um aviso claro quando essa proteção não está disponível. (#1818)
- Os argumentos IPC de computação são validados rigorosamente antes do uso. (#1820)
- Solicitações de conectores que atingem o timeout não são mais repetidas: uma solicitação travada falha uma única vez, com uma explicação clara do prazo, em vez de realizar três tentativas de 30 segundos. (#1829)
- O cancelamento da consulta periódica de um conector passa a ter efeito imediato, sem aguardar o intervalo da consulta. (#1830)
- As sessões do revisor agora limitam o tamanho dos logs capturados, impedindo que saídas muito grandes de ferramentas travem o aplicativo. (#1824)
- A solicitação para dar Star no GitHub respeita um intervalo entre projetos e aparece com muito menos frequência. (#1813)
- As traduções em japonês passaram por uma revisão de terminologia e consistência. (#1823)
- O erro de inicialização nas Configurações agora usa o aviso de erro padrão, com a opção de tentar novamente. (#1835)

## 🐛 Correções de bugs

- **Computação remota** — uma sessão permanece ativa enquanto seus trabalhos remotos ainda estão em execução, em vez de aparecer como concluída antes da hora (#1803), e falhas inesperadas de envio são registradas com sua causa real (#1811).
- **Artefatos** — arquivos gerados por execuções de tarefas ou da CLI e por continuações de delegações preservam a proveniência do ambiente de execução e não falham mais durante a finalização. (#1802, #1810)
- **Sessões** — sessões vazias do Claude criadas por ramificação agora podem ser excluídas (#1806), e o card exibido ao passar o cursor sobre uma sessão fica alinhado à respectiva linha e permite renomeá-la diretamente (#1843, #1845).
- **Janela de contexto** — quando os detalhes por chamada cobrem apenas parte do histórico após a troca de framework ou modelo, um aviso em linha informa essa cobertura, em vez de ocultar interações sem explicação. (#1828)
- **Notebook** — condições de corrida em execuções enfileiradas não geram mais resultados de ciclo de vida incoerentes, como execuções marcadas como falhas depois do reparo bem-sucedido do ambiente de execução ou interrupções duplicadas. (#1832)
- **Planos** — quando uma sessão restaurada não consegue ler seu plano, ela exibe um aviso visível de que uma nova tentativa está em andamento, em vez de omitir silenciosamente o card do plano. (#1834)
- **Arquivos** — falhas ao remover o acesso a diretórios ou carregar a linhagem de artefatos agora aparecem em linha, com a opção de tentar novamente, em vez de ocorrerem silenciosamente. (#1842)
- **Espaço de trabalho** — as visualizações de arquivos agora são fechadas com um único pressionamento de `Cmd/Ctrl+W` (#1804).
