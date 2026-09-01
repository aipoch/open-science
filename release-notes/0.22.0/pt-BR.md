## ✨ Destaques

- **Memória persistente do Agente.** Agora o Agente pode lembrar o que importa entre sessões. As entradas de memória, ativadas opcionalmente e organizadas em categorias específicas do projeto, são recuperadas automaticamente quando uma conversa trata desses assuntos — e tudo pode ser visualizado, editado ou limpo em Configurações. (#1432)
- **Fluxos de trabalho para figuras com proveniência.** As Habilidades científicas incluídas passam a contar com auxiliares registrados para definir o estilo das figuras, compor painéis e criar narrativas prontas para publicação — tudo com base em entradas imutáveis de artefatos, mantendo cada figura rastreável aos dados que a produziram. (#1864)
- **Gerenciamento centralizado de credenciais.** Tokens do GitHub, chaves de conectores e logins de conectores ficam reunidos em um só lugar, com status de integridade de fácil consulta, recuperação guiada quando uma credencial deixa de funcionar e nova verificação automática dos conectores afetados após a correção. (#1865)
- **Uma visão mais completa do uso.** Agora o painel de uso atribui o consumo de tokens à execução correspondente e contabiliza chamadas de modelo feitas fora da conversa principal, incluindo conversas laterais, delegação e compactação do contexto. (#1877, #1874)

## 🚀 Novos recursos

- **Memória persistente do Agente** — categorias de memória opcionais e específicas do projeto, recuperadas pelo Agente antes de interações relevantes; as entradas podem ser criadas, corrigidas e excluídas em um painel dedicado nas Configurações, e a recuperação permanece restrita ao projeto da conversa para não misturar trabalhos sem relação. (#1432)
- **Gerenciamento centralizado de credenciais** — um único painel para tokens de acesso pessoal do GitHub, chaves de API de conectores e logins de conectores, com status de integridade, recuperação guiada e suporte a chaves de planos gratuitos com limite de requisições para fontes de dados abertos. (#1865)
- **Provedor Tencent TokenHub**, com endpoints internacionais e da China continental, além de uma seleção inicial de modelos da Tencent. (#1880)
- **Fluxos de trabalho para figuras com proveniência nas Habilidades incluídas** — auxiliares registrados para definir o estilo das figuras, compor vários painéis e criar narrativas prontas para publicação a partir de entradas imutáveis de artefatos, mantendo as figuras rastreáveis aos dados que as produziram. (#1864)
- **Atribuição de uso por execução** — o uso de tokens é atribuído à execução correspondente e armazenado de forma persistente, mantendo o painel correto após reinicializações. (#1877)

## 🔧 Melhorias

- O painel de uso agora inclui chamadas de modelo feitas fora da conversa principal — em conversas laterais, delegação e compactação do contexto — para que os totais correspondam ao que é cobrado pelo provedor. (#1874)
- Ao expandir o carregamento de uma Habilidade, o documento carregado é exibido como Markdown formatado, oferece uma nova tentativa quando não pode ser obtido e abre sem deslocamentos inesperados da tela. (#1812)
- Uma falha no download da atualização não deixa mais o fluxo sem saída: a caixa de diálogo permanece acionável e permite tentar novamente imediatamente. (#1868)
- Os downloads de atualizações e as instalações de ambientes de execução estão mais seguros: os manifestos de atualização são validados antes do uso, os instaladores precisam vir da origem confiável e instalações que excedem o tempo limite são completamente removidas. (#1873)
- A saída de erros do Agente é resumida em vez de transmitida diretamente aos logs, mantendo resultados comuns de pesquisa e caminhos locais fora dos diagnósticos; amostras brutas continuam disponíveis como uma ferramenta opcional de suporte. (#1858)
- O ambiente de execução do CodeBuddy não envia mais relatórios de erro do ambiente. (#1856)
- O seletor de modelos explica por que um modelo está indisponível no momento, em vez de apenas desabilitá-lo. (#1879)
- Os fluxos de eventos da Task API e da CLI passaram a ter uma identidade de execução estável e repetição limitada, permitindo que consumidores se reconectem sem misturar execuções consecutivas; fluxos revogados ou concluídos deixam de tentar se reconectar indefinidamente. (#1875)
- Campos obrigatórios e erros de campos agora são expostos às tecnologias assistivas. (#1869)

## 🐛 Correções de bugs

- **Backend Claude** — uma resposta interrompida do Claude é retomada em vez de ficar travada (#1853); as credenciais de loopback sobrevivem a reinicializações e reconfigurações (#1878, #1859); e permissões de ferramentas concedidas pelo Agente não são mais ocultadas por configurações obsoletas (#1848).
- **Sessões** — uma primeira interação ocupada não oculta mais a resposta do Agente quando a atualização dos detalhes da sessão e o registro de uso acontecem ao mesmo tempo (#1876), e atualizações consecutivas desses registros são reproduzidas corretamente (#1860).
- **Serviço local e headless** — corpos de solicitações simultâneas e transmissões por WebSocket agora têm limites, e clientes travados são desconectados para que o serviço local continue respondendo sob carga. (#1857)
- **Execuções longas** — eventos brutos do ambiente são liberados após o processamento, reduzindo de forma significativa a memória mantida por tarefas prolongadas. (#1855)
- **Notebook** — metadados internos de roteamento não chegam mais às chamadas de modelo do Notebook. (#1861)
- **Acesso a pastas** — uma resposta obsoleta não pode mais fechar a caixa de diálogo de permissão errada nem informar uma pasta desatualizada. (#1870)
- **Conectores** — a opção de cancelar fica desabilitada enquanto uma operação de salvamento está em andamento, protegendo a continuação do login por OAuth. (#1867)
- **Espaço de trabalho** — a visualização da sessão não permanece mais aberta sob menus de ações. (#1852)
