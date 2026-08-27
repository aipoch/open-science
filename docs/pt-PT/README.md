# Open Science - O ambiente de investigação com IA de código aberto, equipado com agentes científicos de IA

[![Transferir](https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=for-the-badge&logo=github)](https://github.com/aipoch/open-science/releases/latest)
[![Versão](https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=for-the-badge&color=4dabf7)](https://github.com/aipoch/open-science/releases/latest)
[![Licença](https://img.shields.io/badge/License-Apache--2.0-4dabf7?style=for-the-badge)](../../LICENSE)
[![Site](https://img.shields.io/badge/Website-aipoch.com-2f9e44?style=for-the-badge)](https://aipoch.com/open-science)
[![Discord](https://img.shields.io/badge/Discord-Join%20the%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/zxQAYjReRv)

<p align="center">
  <a href="../../README.md"><img alt="README em inglês" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh-Hans/README.md"><img alt="README em chinês simplificado" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../zh-Hant/README.md"><img alt="README em chinês tradicional" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="../ja/README.md"><img alt="README em japonês" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
  <a href="../ko/README.md"><img alt="README em coreano" src="https://img.shields.io/badge/한국어-d9d9d9"></a>
  <a href="../fr/README.md"><img alt="README em francês" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../pt-PT/README.md"><img alt="README em português europeu" src="https://img.shields.io/badge/Português%20(Portugal)-d9d9d9"></a>
  <a href="../ru/README.md"><img alt="README em russo" src="https://img.shields.io/badge/Русский-d9d9d9"></a>
  <a href="../es/README.md"><img alt="README em espanhol" src="https://img.shields.io/badge/Español-d9d9d9"></a>
</p>

> Este documento é uma tradução para o português europeu do `README.md` em inglês. Em caso de divergência, prevalece a [versão em inglês](../../README.md).

O Open Science é um ambiente de investigação com IA de código aberto, local-first e independente de modelo, desenvolvido pela [AIPOCH](https://aipoch.com/open-science) para cientistas e investigadores. Permite realizar investigações reproduzíveis e inspecionáveis com agentes científicos de IA, execução em Python e R, conectores de dados científicos e compatibilidade multiplataforma com macOS, Windows e Linux. Crie um projeto, descreva o seu objetivo de investigação em linguagem natural e deixe que os agentes leiam ficheiros, procurem na web, executem código, consultem fontes de dados científicos e produzam relatórios, tabelas e figuras com proveniência rastreável, tudo num único espaço de trabalho.

O Open Science apoia investigação computacional e intensiva em dados em várias áreas, como aprendizagem automática, estatística, ciências da vida, química, ciência dos materiais, física e ciências ambientais. Apoia o processo de investigação desde a revisão da literatura e a formulação de hipóteses até à execução de código, a análise de dados, a simulação, a visualização e a produção de resultados rastreáveis.

> 💡 **[Open Science v0.20.1 lançado](https://github.com/aipoch/open-science/releases/latest)** _(última atualização: agosto de 2026)_. O Open Science v0.20.1 adiciona detalhes de sessão gerados e editáveis (título e descrição), um atalho para refazer rascunhos no compositor, importação e exportação de definições de clientes MCP com placeholders para credenciais, detalhes de uso por chamada de modelo com um gráfico reformulado da janela de contexto de cada chamada e diagnósticos correlacionados de pedidos HTTP. A versão também inclui operações de rede compatíveis com as definições de proxy, transferências validadas, emparelhamento de acesso remoto reforçado e uma longa lista de correções em sessões, Notebooks, conectores, computação e fornecedores. Consulte as [notas da versão mais recente](https://github.com/aipoch/open-science/releases/latest) para ver todos os detalhes.

<p align="center">
 <img width="1920" height="1140" alt="Espaço de trabalho da aplicação Open Science a mostrar uma sessão de agente com artefactos gerados" src="https://github.com/user-attachments/assets/df59db19-98d7-4071-81f2-c682fbecdf86" />
</p>

## Índice

- [Início rápido](#-início-rápido)
- [Visão geral do produto](#visão-geral-do-produto)
- [Porquê utilizar o Open Science](#porquê-utilizar-o-open-science)
- [Princípios de design](#princípios-de-design)
- [Principais funcionalidades](#principais-funcionalidades)
- [Fornecedores de modelos](#fornecedores-de-modelos)
- [Dados, permissões e confiança](#dados-permissões-e-confiança)
- [Estado do projeto](#estado-do-projeto)
- [Desenvolvimento e criação de pacotes](#desenvolvimento-e-criação-de-pacotes)
- [Roadmap](#roadmap)
- [Relação com o ecossistema AIPOCH](#relação-com-o-ecossistema-aipoch)
- [O que o Open Science não é](#o-que-o-open-science-não-é)
- [Perguntas frequentes](#perguntas-frequentes)
- [Participar](#participar)
- [Licença](#licença)
- [Histórico de estrelas](#histórico-de-estrelas)

## 🚀 Início rápido

Comece a usar o Open Science em três etapas: transfira o instalador da sua plataforma, conclua a configuração guiada do primeiro acesso e crie um projeto de investigação.

### 1. Transfira a aplicação

Aceda à [versão mais recente](https://github.com/aipoch/open-science/releases/latest), expanda **Assets** e escolha o instalador adequado ao seu computador:

| O seu computador                        | Escolha                                      |
| --------------------------------------- | -------------------------------------------- |
| macOS - Apple Silicon (M1 ou mais novo) | O DMG do macOS para Apple Silicon / ARM64    |
| macOS - Intel                           | O DMG do macOS para Intel / x64              |
| Windows x64                             | O instalador para Windows x64                |
| Linux x64                               | O AppImage ou o pacote Debian para Linux x64 |

Consulte os ficheiros e as informações de verificação publicados na página da versão. Se precisar de validar um pacote antes da instalação, consulte [Como verificar a transferência](../../SECURITY.md#verifying-your-download).

> Se o macOS ou o Windows apresentar um aviso de programador não identificado ou editor desconhecido, confirme que o pacote veio da página oficial de Releases antes de continuar.

### 2. Conclua a configuração inicial

O primeiro acesso tem cinco etapas guiadas:

1. **Ambiente** verifica compatibilidade, armazenamento da aplicação, armazenamento seguro de credenciais e acesso à rede.
2. **Ambiente de execução do agente** seleciona e prepara Claude Code, OpenCode ou Codex. Os ambientes geridos pela aplicação podem ser instalados sem Node.js, npm ou palavra-passe de administrador.
3. **Fornecedor do modelo** liga e testa o modelo que pretende utilizar. Escolha um fornecedor integrado, um Gateway Personalizado ou o início de sessão de uma assinatura Claude ou Codex existente.
4. **Ambiente de execução do Notebook** prepara, opcionalmente, ambientes Python e R geridos pela aplicação ou ativa interpretadores detetados e registados manualmente para qualquer uma das linguagens.
5. **Localização dos dados** define onde serão armazenados artefactos grandes, Notebooks, carregamentos e ambientes.

<table>
  <tr>
    <td width="50%"><img src="../images/readme/onboarding-environment.jpg" alt="Verificações automáticas do ambiente no primeiro acesso ao Open Science"></td>
    <td width="50%"><img src="../images/readme/onboarding-model-provider.jpg" alt="Configuração do fornecedor do modelo no primeiro acesso ao Open Science"></td>
  </tr>
  <tr>
    <td align="center"><sub>Verificações de compatibilidade do host, armazenamento e rede</sub></td>
    <td align="center"><sub>Validação do fornecedor, da chave de API, do endpoint e do modelo</sub></td>
  </tr>
</table>

A execução de Notebooks é opcional. Todas as verificações obrigatórias do ambiente e do ambiente de execução do agente têm de ser concluídas com sucesso antes que `Continuar` seja ativado, e a ligação ao modelo tem de ser validada antes de concluir a configuração. As definições do Notebook e da localização dos dados podem manter os valores predefinidos e ser alteradas depois em Definições.

### 3. Inicie um projeto de investigação

1. Clique em **Novo projeto** e dê ao projeto um nome de investigação estável e, se quiser, uma descrição.
2. Abra uma sessão e descreva o objetivo, os dados de entrada, as restrições, os resultados desejados e como o resultado deve ser verificado.
3. Anexe os ficheiros de origem, selecione um modelo validado e escolha um modo de aprovação.
4. Envie a tarefa. Examine a atividade das ferramentas do agente, aprove as ações sensíveis e abra os artefactos gerados no painel de pré-visualização.
5. Para explorar outra direção, edite uma mensagem anterior do utilizador e reenvie-a numa nova ramificação; use os controlos de revisão da mensagem para voltar a qualquer um dos caminhos.
6. Abra a pré-visualização **Proveniência** de um artefacto para consultar as suas versões e as evidências disponíveis para o resultado selecionado.
7. Continue o trabalho em sessões futuras. Use `@` para referenciar um ficheiro existente do projeto e `/` para selecionar explicitamente uma competência ativada.

> As capturas de ecrã deste README ilustram o fluxo de trabalho. Rótulos, catálogos e outros detalhes da interface podem ser diferentes na versão instalada.

## Visão geral do produto

O Open Science organiza a investigação em projetos e sessões para que cada resultado permaneça ligado às evidências que o produziram. As secções a seguir apresentam o espaço de trabalho, a proveniência dos artefactos, as pré-visualizações, as competências científicas e os conectores de dados.

### Um único espaço de trabalho, da tarefa aos artefactos rastreáveis

Os projetos mantêm juntos as sessões relacionadas, os carregamentos, os ficheiros gerados e o estado das pré-visualizações. A conversa regista a resposta do agente e os comandos, leituras de ficheiros, edições, investigações e chamadas de conectores que a produziram. Cada artefacto gerado é armazenado como uma versão imutável com checksum. A pré-visualização **Proveniência** mostra as evidências que o Open Science conseguiu verificar no momento da criação: o código produtor e o histórico de execução, as entradas referenciadas, um inventário observado do ambiente, a ramificação da conversa que gerou o artefacto e eventuais apontamentos do revisor associados àquela versão. Evidências ausentes são apresentadas como indisponíveis, sem suposições.

<table>
  <tr>
    <td width="50%"><img src="../images/readme/project-files.jpg" alt="Biblioteca de ficheiros do projeto com carregamentos e artefactos de investigação gerados"></td>
    <td width="50%"><img src="../images/readme/csv-preview.jpg" alt="Pré-visualização de um artefacto CSV ao lado de uma sessão de agente concluída"></td>
  </tr>
  <tr>
    <td align="center"><sub>Carregamentos e ficheiros gerados organizados por projeto e sessão</sub></td>
    <td align="center"><sub>Pré-visualizações nativas mantêm os dados e o histórico da investigação lado a lado</sub></td>
  </tr>
</table>

Relatórios, figuras e tabelas gerados permanecem associados à sessão e também são reunidos na biblioteca de ficheiros do projeto. Os separadores de pré-visualização mantêm o resultado ativo visível quando o painel muda de tamanho, e nomes longos preservam o sufixo e a extensão que permitem identificá-los. O Open Science visualiza dados científicos comuns, PDFs, documentos do Office (DOCX, XLSX, PPTX), imagens (com zoom e deslocamento), código-fonte com realce de sintaxe, estruturas e reações moleculares e o histórico do Notebook. Os limites da pré-visualização não truncam o ficheiro original: o artefacto completo continua disponível para o agente e para ferramentas externas. Use `Cmd/Ctrl+F` para procurar transcrições, saídas do Notebook e páginas renderizadas em todo o espaço de trabalho, ou `Cmd/Ctrl+K` para abrir a paleta de comandos do projeto. O modo escuro completa o ambiente: altere o tema em **Definições → Geral** e toda a interface da aplicação, a transcrição e a paleta do renderizador mudam sem piscar. A interface também está disponível em espanhol, francês, chinês simplificado e tradicional, japonês, coreano, português europeu e russo, com seletor de idioma em tempo de execução nas Definições.

### Crie uma ramificação da conversa sem perder o original

Edite uma mensagem concluída do utilizador para reenviar um prompt revisto a partir daquele ponto. O Open Science cria uma nova ramificação de mensagens em vez de eliminar as interações posteriores, e os controlos de revisão permitem alternar entre os caminhos original e alternativo. A ramificação selecionada, a atividade das ferramentas, os anexos e os artefactos gerados persistem ao trocar de projeto e reiniciar a aplicação. A proveniência continua associada à ramificação exata que produziu cada versão do artefacto; assim, explorar outra hipótese não confunde o registo do resultado anterior.

### Competências científicas e conectores de dados

O Open Science inclui um catálogo crescente de **18 competências em destaque**, baseadas em ficheiros: AlphaFold2, Boltz, Borzoi, Chai-1, DiffDock, Environment & Packages, ESM-2, ESMFold2, Evo 2, Indication Dossier, LigandMPNN, Literature Review, OpenFold3, ProteinMPNN, scGPT, scvi-tools, SolubleMPNN e **Remote Compute (SSH)**, usada para enviar e recolher trabalhos de longa duração em clusters HPC remotos. Pode criar competências pessoais, enviar pacotes `SKILL.md`/ZIP/`.skill`, pré-visualizar e importar competências compatíveis do GitHub com acesso autenticado opcional ou importar competências já instaladas nos diretórios globais dos seus agentes. O agente também pode solicitar a importação de um pacote a partir de um anexo da sessão ou de uma URL pública do GitHub, com pré-visualização e confirmação controladas pela aplicação antes que qualquer ficheiro seja gravado. As competências ativadas podem ser selecionadas diretamente no compositor com `/`.

A aplicação também inclui **24 conectores de investigação integrados**: Literature Graph, PubMed, bioRxiv, Genes & Ontologies, Genomes, BioMart, Variants, Human Genetics, Clinical Genomics, Structures & Interactions, Protein Annotation, Expression, Omics Archives, CellGuide, Regulation, RNA, Chemistry, ChEMBL, ZINC, Molecule Viewer, Clinical Trials, Drug Regulatory, Cancer Models e Research Resources. Conectores integrados e personalizados permanecem protegidos pelo sistema de permissões, com os controlos `Permitir sempre`, `Perguntar a cada vez` e `Bloquear` para cada ferramenta. A aplicação instalada mostra os catálogos atuais de competências, conectores e ferramentas.

<table>
  <tr>
    <td width="50%"><img src="../images/readme/skills.jpg" alt="Definições do Open Science a mostrar competências científicas em destaque"></td>
    <td width="50%"><img src="../images/readme/connectors.jpg" alt="Definições do Open Science a mostrar conectores integrados de dados científicos"></td>
  </tr>
  <tr>
    <td align="center"><sub>Competências de investigação legíveis e reutilizáveis</sub></td>
    <td align="center"><sub>Bases de dados científicas disponibilizadas como ferramentas de agente sujeitas a permissão</sub></td>
  </tr>
</table>

## Porquê utilizar o Open Science

O Open Science reúne tarefas de investigação, execução, ficheiros e evidências num único espaço de trabalho local e inspecionável.

O trabalho de investigação costuma ficar dividido entre janelas de chat, Notebooks, scripts locais, bases de dados científicos, navegadores de ficheiros e ferramentas de relatório. O contexto perde-se a cada transferência, e a resposta muitas vezes fica separada do código e dos ficheiros que a produziram.

O Open Science reúne todas essas partes num único espaço de trabalho inspecionável:

- **Trabalho que persiste.** Projetos, sessões, rascunhos, ficheiros, pré-visualizações e histórico de execução sobrevivem às reinicializações da aplicação.
- **Execução, não apenas sugestões.** Com a aprovação do utilizador, o agente pode executar comandos, Python e R, editar ficheiros, procurar, chamar conectores e gerar artefactos.
- **Caminhos alternativos sem perder trabalho.** Reveja um prompt anterior numa nova ramificação de mensagens e alterne entre as direções de investigação resultantes.
- **Resultados rastreáveis.** Versões imutáveis dos artefactos preservam as evidências de produção que o Open Science consegue verificar e identificam explicitamente as que não consegue.
- **Várias opções de modelo.** Use um fornecedor de nuvem integrado, um gateway personalizado compatível ou uma assinatura Claude ou Codex; escolha no compositor o modelo e o nível de raciocínio de cada sessão.
- **Controlo local-first.** A aplicação é executada e o estado do projeto é armazenado no seu computador; chamadas externas passam por serviços que configura ou aprova explicitamente.
- **Inspecionabilidade.** O código-fonte, as competências, as definições dos conectores, a atividade das ferramentas, os ficheiros gerados e a proveniência dos artefactos ficam disponíveis para análise.
- **Extensibilidade.** Adicione competências e conectores MCP sem depender do roadmap de plugins de uma plataforma fechada.
- **Sem licença por utilizador.** O Open Science é um software Apache-2.0. Paga apenas pelo modelo ou pela infraestrutura que escolher usar.

O Open Science é um produto independente, desenvolvido do zero. Não é um proxy, um cliente não oficial nem uma nova aparência para outra aplicação de investigação com IA.

## Princípios de design

O Open Science baseia-se em sete princípios de design que orientam a integração entre código, dados, modelos e supervisão humana: abertura por predefinição, compatibilidade explícita com vários fornecedores, controlo local-first dos dados, supervisão humana, registos de investigação duráveis, componentes combináveis e limites científicos honestos.

- **Aberto por predefinição.** Código-fonte, formatos, conectores e competências devem continuar inspecionáveis e permitir forks.
- **Vários fornecedores com compatibilidade explícita.** A aplicação valida a configuração do fornecedor e deixa claros os requisitos do endpoint, em vez de tratar todos os protocolos de API como intercambiáveis.
- **Local-first e consciente dos dados.** Mantenha o estado do projeto local, torne visíveis os fluxos de dados externos e deixe a autonomia como opção.
- **Supervisão humana.** Edições de ficheiros, comandos, acesso à rede e chamadas de conectores são controlados por perfis de aprovação explícitos.
- **Registos de investigação duráveis.** Sessões, atividade das ferramentas, histórico do Notebook e versões imutáveis dos artefactos devem continuar disponíveis para análise após o término da execução, com indicação clara das evidências indisponíveis.
- **Componentes combináveis.** Competências, conectores, modelos, pré-visualizações e futuros backends de computação devem ser partes substituíveis, não uma caixa-preta única.
- **Limites científicos honestos.** O resultado gerado não substitui o julgamento especializado, a revisão estatística nem a validação com evidências primárias.

## Principais funcionalidades

O Open Science combina gestão de projetos, execução de agentes com vários modelos, Notebooks Python e R, conectores de dados científicos, versões imutáveis de artefactos com proveniência e controlos de supervisão humana baseados em permissões, tudo num único espaço de trabalho local. A aplicação instalada e as [notas da versão mais recente](https://github.com/aipoch/open-science/releases/latest) são as fontes oficiais para catálogos em evolução, detalhes de empacotamento e opções recém-adicionadas.

| Área                             | Recurso principal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Projetos e sessões**           | Crie, renomeie e elimine projetos; mantenha várias sessões, inclusive fixadas; transforme prompts concluídos em ramificações de mensagens persistentes e selecionáveis sem eliminar o caminho posterior original; mantenha conversas laterais persistentes dentro de uma sessão; gere e edite detalhes da sessão (título e descrição); restaure trabalhos recentes, rascunhos, histórico da conversa e estado da pré-visualização.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Fluxo de trabalho do agente**  | Tarefas em linguagem natural, respostas transmitidas em tempo real, cartões tipados de atividade das ferramentas agrupados por títulos que indicam a finalidade declarada, indicador em tempo real de utilização do contexto com estimativas por categoria, compactação do contexto a pedido e persistência entre reinicializações; controlos de interrupção, pausas para aprovação e confirmação, com preferência memorizada, antes de fechar ou sair durante uma tarefa em execução; fila de mensagens no compositor para preparar mensagens de acompanhamento durante uma interação em curso; histórico unificado para desfazer e refazer rascunhos; criação de uma nova sessão a partir de mensagens concluídas do agente; notificações no computador com o motivo da atenção, indicadores persistentes de conversas não lidas e sinalização nativa para aprovações bloqueantes; central de mensagens de notificação entre superfícies, com estado de leitura persistente e preservação de destinos eliminados; cartões estruturados para esclarecimentos do agente com várias perguntas; estado da sessão em tempo real no painel inicial; metadados de duração das mensagens com popovers de tempo decorrido e uso; utilização de tokens por interação, com detalhes por chamada de modelo e gráfico da janela de contexto de cada chamada; identificação do framework do agente e do modelo nas interações concluídas; paleta de comandos do projeto; leitura de frames, ações do projeto e contexto do agente no âmbito do projeto; linhas refinadas na barra lateral de sessões; referências (`#`) a outras sessões no compositor, com acesso de leitura limitado à interação; avisos de conversas laterais inseridos na interação principal em curso; procura por número da sessão na investigação global; planos de sessão sujeitos a revisão, com contratos de execução duráveis e comandos CLI para exibir, aprovar e rejeitar planos; renderização suave das respostas em tempo real; painéis laterais recolhíveis; atalho de teclado para nova conversa; e recuperação de sessões interrompidas pela reinicialização da aplicação. |
| **Delegação a subagentes**       | Delegação de nível de produção a subagentes, com mensagens e recuperação persistentes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Modelos**                      | Fornecedores de nuvem integrados, gateways personalizados compatíveis, início de sessão com assinaturas Claude e Codex, validação de ligação, entrada multimodal de imagens por modelo, seletor combinado no compositor de cada sessão para o modelo e o nível de raciocínio compatível, cartão consolidado de modelos por função para as políticas de subagente, revisor e visão, padrões nas Definições para novas sessões e um seletor dedicado do modelo de visão, com retransmissão persistente das evidências de imagem para backends que aceitam apenas texto. Os fornecedores e formatos de API disponíveis são validados de acordo com o backend de agente selecionado.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Backend de agente**            | Backend selecionável de framework de agente, permitindo que o mesmo espaço de trabalho use mais de uma implementação de agente subjacente; opções de fornecedor e modelo validadas conforme o backend selecionado; backends geridos pela aplicação que podem ser instalados, alternados e removidos nas Definições; e repetição de contexto consciente do agente, respeitando o caminho de contexto de cada framework após trocas ou retomadas.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Especialistas**                | Perfis pessoais de agentes especialistas com recursos definidos, transferência imediata durante a execução pelo agente principal, personalização por conversa, importação e exportação de pacotes, identidades imutáveis de invocação, IDs gerados a partir do nome com substituições validadas e um Mercado de Especialistas com âmbito definido, verificação de pacotes assinados, fontes oficiais e do GitHub aprovadas pelo utilizador, fallback por CDN, progresso de transferência e resolução de conflitos entre competências na importação. O Mercado separa as pré-visualizações Instalados e Mercado, oferece uma única entrada principal para navegação e um caminho explícito de retorno, abre imediatamente listagens verificadas em cache com atualização manual, permite instalação direta pelos detalhes e oferece ícones partilhados de recursos, edição rápida da aparência e navegação pelas linhas de recursos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Organização de recursos**      | Tags partilhadas por competências, conectores e especialistas executáveis, com uma tag protegida de Favoritos, menus de atribuição, badges, filtros, navegador pesquisável de tags nas Definições e ordenação persistente por arraste ou teclado.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Execução**                     | Kernels persistentes de Python, R e REPL no plano de controlo, com histórico durável de código e saída, além de comandos sem estado executados na linha de comandos e registados no mesmo histórico de execução; inferência REPL limitada para avaliação orientada pelo agente; ambientes geridos pela aplicação com provisionamento offline; uso de interpretadores Python e R fornecidos pelo utilizador; hosts remotos de computação SSH com autenticação por chave ou palavra-passe e credenciais armazenadas com criptografia do sistema operativo como destinos adicionais de execução; terminal do utilizador partilhado com o agente; inventário apenas leitura dos pacotes instalados por ambiente de execução; acesso de leitura aos artefactos do Notebook para inspeção de ficheiros pelo agente; progresso da instalação de pacotes com tempo decorrido na atividade da sessão; e carregamento progressivo do histórico de Notebooks de longa duração. A gestão de pacotes para ambientes R externos continua manual.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Entradas e ficheiros**         | Anexos de até 10 GB por ficheiro com carregamento por streaming; biblioteca no nível do projeto com paginação indexada, agrupamento por sessão, investigação de nomes de ficheiro restrita aos ficheiros de origem, pré-visualizações em grelha e lista, modal ampliado para projetos grandes, pré-visualização dividida do ficheiro ao lado da sessão, cartões de artefactos gerados, referências `@` a carregamentos e saídas existentes, menções `@path` para conceder acesso a pastas locais com navegação entre unidades, barra de caminho editável e seletor de unidade, transferência e exportação de ficheiros, transferências seletivas de artefactos da sessão, conversão de colagens longas de texto simples em anexos com restauração exata, exportação da conversa como Markdown ou PDF e exportação da sessão como `.ipynb`, por separador ou em lote.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Artefactos e proveniência**    | Versões imutáveis de artefactos no âmbito da sessão, com conteúdo identificado por checksum e, quando disponíveis, código produtor, histórico de execução, referências exatas das entradas, inventário do ambiente, contexto da ramificação de mensagens produtora, acesso à linhagem do artefacto e evidências do revisor associadas à versão, além de navegação entre versões e links diretos entre evidências relacionadas.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Formatos de pré-visualização** | Pré-visualizações responsivas em vários separadores para dados científicos comuns, PDFs, documentos do Office (DOCX, XLSX, PPTX), imagens, inclusive TIFF, com zoom e deslocamento, código-fonte com realce de sintaxe, estruturas e reações moleculares e histórico do Notebook; podem ser apresentadas em linha ou em ecrã inteiro, com navegação contextual de volta à conversa que produziu o artefacto.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Gestão de dados locais**       | Dados locais do projeto e da aplicação, localização de armazenamento configurável, migração guiada e definições globais de proxy nos modos sistema, manual e direto; painel de utilização de tokens com resumos por período, mapa de calor de atividade de 30 dias e gráficos diários de entrada, cache e saída.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Competências**                 | **18 competências integradas em destaque**; competências pessoais com nomes imutáveis em minúsculas e separados por hífen; criação conversacional de competências em linguagem natural dentro de uma sessão; opção de guardar uma interação concluída como competência; acesso direto à pasta de competências do utilizador com validação externa de pacotes; gestão em massa para ativar e desativar com filtros de origem, estado e texto; envio de pacotes; pré-visualização e importação autenticadas do GitHub; importação de competências globais instaladas com pré-visualização dos candidatos; importações de pacotes solicitadas pelo agente a partir de anexos da sessão ou URLs do GitHub; APIs JavaScript do host em camelCase para scripts de competências, com validação estruturada; controlos para ativar e desativar; e seleção explícita com `/` numa sessão. O painel Competências reformulado unifica a filtragem do agente principal e dos especialistas, mostra pilhas de avatares dos utilizadores reais com um popover limitado "Usado por", consolida as ações por linha e permite eliminação em massa com confirmação, protegendo competências integradas e associadas a especialistas.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Conectores**                   | **24 conectores de investigação integrados** com estado do ambiente de execução e superfícies de recuperação; conectores MCP locais e remotos personalizados com nomes imutáveis de invocação em minúsculas, separados dos nomes de exibição editáveis; IDs locais gerados a partir do nome com substituições validadas; metadados de contacto; permissões por conector e por ferramenta; e importação e exportação de definições predefinidas de clientes MCP com placeholders para credenciais. As interações com o catálogo seguem os mesmos padrões compactos de gestão das competências.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Controlos de segurança**       | Perfis de conversa `Solicitar aprovação`, `Aprovar automaticamente as edições` e `Acesso completo`; caixas de diálogo de aprovação com pré-visualização prévia do código e decisões por chamada ou conversa; recusas limitadas à interação que bloqueiam novas tentativas ou alternativas para a operação recusada; permissões persistentes com âmbito global, de projeto e de sessão, com filtros, revogação por linha e por família e opção Desfazer; além de políticas por conector e por ferramenta.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Revisão e verificação**        | Revisor opcional que audita uma interação concluída com base na própria transcrição, no log de execução e nos artefactos, apresenta apontamentos classificados como sucesso, alerta ou falha e pode executar um ciclo limitado de correções; política configurável do modelo revisor, que acompanha o modelo ativo ou fixa um fornecedor, modelo e nível de raciocínio dedicados; e snapshots persistentes da avaliação do revisor com atribuição das correções.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Distribuição e apoio**         | Instaladores para macOS, Windows e Linux; assistente simplificado de primeiro acesso para ambiente, ambiente de execução do agente, fornecedor do modelo, ambiente de execução do Notebook e localização dos dados; interface localizada em espanhol, francês, chinês simplificado e tradicional, japonês, coreano, português europeu e russo, com um README traduzido para cada idioma compatível e outros guias de contribuição multilíngues; orientações de atualização com lembretes em destaque; diagnósticos locais; e links da comunidade.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Fornecedores de modelos

No produto, o Open Science é independente de modelo: ligue-o aos principais fornecedores de LLM na nuvem, a um gateway personalizado ou reutilize uma assinatura Claude ou Codex existente. A disponibilidade dos fornecedores depende atualmente do backend de agente selecionado e dos protocolos de API compatíveis. Há quatro formas de ligar um modelo:

| Modo do fornecedor                   | Como funciona                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Fornecedores de nuvem integrados** | Escolha um fornecedor apresentado na lista da aplicação instalada e autentique-se com a chave solicitada.                                                                                                                                                                                                                                                          |
| **Gateway Personalizado**            | Introduza um URL base compatível, uma chave de API e o ID exato do modelo. O formato de API predefinido (Messages, Chat Completions ou Responses) é derivado do framework de agente ativo; assim, um novo gateway personalizado funciona sem configuração adicional.                                                                                               |
| **Assinatura Codex**                 | Selecione o framework de agente Codex e escolha Assinatura Codex como tipo de fornecedor.                                                                                                                                                                                                                                                                          |
| **Assinatura Claude**                | Entre com uma assinatura Claude num de dois modos: **partilhado** (início de sessão pelo navegador que armazena credenciais no perfil predefinido `~/.claude`) ou **isolado** (execução de `claude setup-token`, gerida pela aplicação num `CLAUDE_CONFIG_DIR` próprio, completamente isolado de `~/.claude/`, com fluxo pelo navegador e opção de colar o token). |

O fornecedor legado **Local Claude** foi removido. As entradas Local Claude armazenadas anteriormente
são descartadas durante a atualização; adicione **Assinatura Claude** e autentique-se pelo início de sessão
partilhado no navegador ou pelo fluxo isolado `claude setup-token`.

Os fornecedores de nuvem integrados incluem atualmente OpenAI, Anthropic, Grok (xAI), DeepSeek, Zhipu AI (GLM) com endpoint dedicado ao GLM Coding Plan, Kimi (Moonshot), MiniMax, StepFun com endpoint dedicado à assinatura Step Plan, Xiaomi MIMO, SenseNova, Volcengine Ark, Bailian (Alibaba Cloud) com endpoint dedicado à assinatura Bailian for Plan e o gateway agregador OpenRouter, entre outros; alguns são específicos de determinadas regiões.

Os fornecedores, modelos disponíveis e endpoints regionais podem evoluir independentemente deste README. Considere o seletor de fornecedores e o teste de ligação na aplicação instalada como fontes oficiais.

## Dados, permissões e confiança

O Open Science armazena no computador local os dados do projeto, as definições, as versões dos artefactos e as evidências de proveniência. As chaves de API ficam armazenadas localmente e usam o armazenamento seguro de credenciais do sistema operativo quando disponível. Os logs são locais e não são enviados automaticamente.

Ainda pode haver fluxos externos de dados, que devem ser analisados:

- Os pedidos ao modelo enviam o prompt e o contexto necessário ao fornecedor selecionado.
- Investigações na web e conectores remotos enviam os parâmetros apresentados a serviços externos.
- Conectores locais podem executar comandos fidedignos no computador.
- Anexos, referências `@`, logs e relatórios gerados podem conter dados de investigação confidenciais.

Escolha o perfil de permissão mais restrito que atenda à tarefa:

| Modo                                 | Comportamento                                                                                              | Uso recomendado                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `Solicitar aprovação`                | Solicita aprovação antes de edições, comandos, acesso à rede e chamadas de conectores                      | Novos fluxos de trabalho, dados confidenciais e scripts desconhecidos |
| `Aprovar automaticamente as edições` | Permite automaticamente edições no espaço de trabalho; solicita aprovação para comandos, rede e conectores | Edição fidedigna de ficheiros com acesso externo controlado           |
| `Acesso completo`                    | Permite automaticamente edições, comandos, acesso à rede e conectores                                      | Trabalho não assistido, totalmente fidedigno e com âmbito claro       |

Consulte os parâmetros dos conectores e a atividade das ferramentas antes de aprovar. Nunca inclua chaves de API, tokens de acesso, identificadores de pacientes, dados não publicados ou caminhos locais confidenciais em capturas de ecrã ou logs de issues públicas.

## Estado do projeto

O Open Science é uma aplicação para computador em desenvolvimento ativo, disponível para macOS, Windows e Linux. O desenvolvimento centra-se em fluxos de investigação local-first fidedignos, capacidades científicas extensíveis, artefactos de investigação rastreáveis e execução controlada pelo utilizador.

Consulte a [versão mais recente](https://github.com/aipoch/open-science/releases/latest) para obter as transferências atuais e as alterações específicas de cada versão. Para ver as funcionalidades entregues, parciais e planeadas, consulte o [Mapa de funcionalidades](../../ROADMAP.md#capability-map).

O Open Science auxilia na execução e no registo da investigação; os investigadores continuam responsáveis pelos métodos, pela interpretação, pela privacidade e pela validade científica.

## Desenvolvimento e criação de pacotes

O Open Science é uma aplicação Electron desenvolvida com React, TypeScript, Prisma/SQLite e um ambiente de execução de agente baseado em ACP.

Pré-requisitos para desenvolvimento a partir do código-fonte:

- Node.js 22 (consulte [`.nvmrc`](../../.nvmrc)) com npm
- Git
- Python 3 apenas se quiser executar Notebooks

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

`npm install` gera automaticamente o cliente Prisma e instala as dependências nativas do Electron. `npm run dev` cria os pacotes do processo principal e do preload do Electron, inicia o renderizador e abre a aplicação para computador. Os dados de desenvolvimento ficam isolados em `~/.open-science-project`.

Comandos úteis:

| Comando                | Finalidade                                                                    |
| ---------------------- | ----------------------------------------------------------------------------- |
| `npm run dev`          | Inicia a aplicação de desenvolvimento                                         |
| `npm run dev:web`      | Inicia a aplicação de desenvolvimento e a interface web local (127.0.0.1)     |
| `npm run dev:headless` | Inicia o backend de desenvolvimento e a interface web, sem janela do Electron |
| `npm run lint`         | Executa o ESLint                                                              |
| `npm run typecheck`    | Verifica os tipos do processo principal e do renderizador                     |
| `npm test`             | Executa a suíte Vitest                                                        |
| `npm run build`        | Verifica os tipos e compila a aplicação                                       |
| `npm run build:web`    | Compila a interface web local opcional                                        |
| `npm run build:mac`    | Empacota builds para macOS                                                    |
| `npm run build:win`    | Empacota builds para Windows                                                  |
| `npm run build:linux`  | Empacota builds para Linux                                                    |

Os pacotes gerados são gravados em `dist/`.

### Interface web local e modo headless

Opcionalmente, o backend da aplicação para computador pode disponibilizar o mesmo renderizador num navegador no computador local. Esta funcionalidade está desativada por predefinição e escuta apenas em `127.0.0.1`.

```bash
npm run build:web
npm run dev:web
```

Abra a URL autenticada apresentada pela aplicação. Use `npm run dev:headless` para iniciar o backend, o ícone da bandeja, o ambiente de execução do agente e o serviço web local sem abrir uma janela do Electron. Defina `OPEN_SCIENCE_WEB_PORT` para escolher a porta (predefinição: `44100`). Encerrar explicitamente a aplicação ainda finaliza normalmente os processos do agente e do Notebook.

### Acesso remoto por dispositivos móveis

A mesma interface web local pode ser acedida por um telemóvel ou tablet por meio do emparelhamento com o Remote.It. Emparelhe um navegador usando um código de seis dígitos do Open Science e aprove-o uma vez no computador; depois disso, o espaço de trabalho continua acessível sem expor diretamente o servidor de loopback. A confiança no navegador pode ser revogada, e mudanças de modo ou o encerramento do serviço invalidam imediatamente as sessões remotas ativas.

### CLI e SDK em modo headless

A CLI headless e o SDK Node.js sem dependências usam o mesmo daemon local, os mesmos projetos, sessões, credenciais e permissões das interfaces para computador e web. As instruções detalhadas ficam junto ao pacote publicável, mantendo uma única referência de comandos:

- [Guia da CLI](../../packages/open-science/CLI.md) - instalação, ciclo de vida do serviço, automação de tarefas,
  artefactos, formatos de saída e códigos de saída
- [Visão geral do pacote SDK](../../packages/open-science/README.md) - início rápido com Node.js e ponto de entrada do pacote

## Roadmap

O roadmap do produto e o estado das funcionalidades são mantidos em [ROADMAP.md](../../ROADMAP.md). Este README não duplica deliberadamente a lista dinâmica de prioridades ou metas de versão.

## Relação com o ecossistema AIPOCH

<img width="1920" height="1140" alt="Como o Open Science se enquadra no ecossistema AIPOCH como camada de orquestração para computador de fluxos abertos de IA científica" src="https://github.com/user-attachments/assets/0ab847b1-1b7d-43f4-8c11-480a578e6c7d" />

A [AIPOCH](https://aipoch.com/) ([organização no GitHub](https://github.com/aipoch)) desenvolve o [Open Science](https://aipoch.com/open-science) como a camada de orquestração para computador de fluxos abertos de IA científica.

- [aipoch/medical-research-skills](https://github.com/aipoch/medical-research-skills) é uma coleção mais ampla de mais de 500 competências de investigação médica e científica baseadas em ficheiros. Todas podem ser inspecionadas, importadas e combinadas com o Open Science a partir do GitHub.
- O Open Science fornece o espaço de trabalho de projetos e sessões, o ambiente de execução do agente, a execução, os artefactos, as pré-visualizações, as permissões e os conectores que transformam essas instruções num fluxo interativo.

Competências e conectores podem executar código ou enviar dados externamente. Examine o código-fonte, a licença, os scripts e o comportamento de rede antes de os ativar.

## O que o Open Science não é

O Open Science é uma ferramenta para executar e registar investigações, não uma interface genérica de chat, um cliente não oficial ou um substituto para a revisão científica.

- **Não é apenas uma interface de chat.** O produto é organizado em torno de projetos persistentes, execução, ficheiros, artefactos e atividade de ferramentas que pode ser analisada.
- **Não é um cliente não oficial de outro produto.** É uma implementação independente, com código, modelo de dados, interface e roadmap próprios.
- **Não substitui o julgamento científico.** Os resultados ainda exigem revisão do domínio, validação estatística e verificação com fontes primárias.

## Perguntas frequentes

### O que devo fazer ao abrir o Open Science pela primeira vez?

R: Conclua as cinco etapas da configuração: **Ambiente**, **Ambiente de execução do agente**, **Fornecedor do modelo**, **Ambiente de execução do Notebook** e **Localização dos dados**. Corrija as linhas obrigatórias marcadas como `Ação necessária`, instale ou repare o agente selecionado quando essa opção for oferecida e teste a ligação com o modelo. A configuração do Notebook e uma localização de dados personalizada são opcionais.

### O que é uma chave de API e onde posso consegui-la?

R: Uma chave de API é uma credencial secreta emitida por um fornecedor de modelos. Crie ou copie uma na consola de programador ou de API desse fornecedor. O fornecedor pode cobrar pelos pedidos feitos com a chave. Trate-a como uma palavra-passe: nunca a partilhe nem a adicione a um repositório.

### Preciso de uma chave de API?

R: Não, se reutilizar o início de sessão de uma assinatura existente: uma assinatura Claude com início de sessão partilhado pelo navegador ou com o fluxo isolado `claude setup-token` gerido pela aplicação, ou uma assinatura ChatGPT/Codex no backend Codex. Fornecedores de nuvem integrados e gateways personalizados exigem chaves próprias.

### Quais fornecedores de modelos posso usar?

R: Abra o seletor de fornecedores durante a configuração ou em `Definições → Modelo` para ver as opções compatíveis com a aplicação instalada e o backend de agente selecionado. Pode usar um fornecedor de nuvem integrado, um Gateway Personalizado compatível, uma assinatura Claude com início de sessão partilhado ou isolado, ou uma assinatura Codex no backend Codex.

### Porque é que o teste de ligação ao modelo falha?

R: Verifique se a chave de API tem caracteres ausentes ou espaços, verifique a URL base e a região, use o ID exato do modelo informado pelo fornecedor e confirme o acesso à rede e o saldo da conta. Para uma assinatura Claude, tente novamente o início de sessão partilhado pelo navegador ou atualize a credencial isolada `claude setup-token`, conforme o modo selecionado.

### Porque é que `Continuar` fica desativado durante a configuração?

R: A etapa atual ainda não cumpriu a condição obrigatória. Dependendo da etapa ativa, corrija as linhas do ambiente marcadas como `Ação necessária`, instale ou repare o ambiente de execução do agente selecionado ou valide o fornecedor do modelo. A configuração do Notebook é opcional e afeta apenas a execução de Notebooks.

### A configuração terminou. Como inicio uma tarefa de investigação?

R: Crie ou abra um projeto, inicie uma sessão, anexe os ficheiros de origem e descreva o objetivo, as restrições, o resultado esperado e os critérios de validação. Use `@` para referenciar um ficheiro do projeto e `/` para selecionar uma competência ativada.

### Como executo trabalhos num cluster HPC remoto?

R: Ative a competência **Remote Compute (SSH)** em **Definições → Competências**, registe o cluster em **Definições → Computação**, inicie uma sessão e selecione a competência com `/remote-compute-ssh`. Ela cuida do registo do host, de comandos curtos por SSH e do envio totalmente assíncrono de trabalhos. Quando o trabalho termina, a aplicação inicia automaticamente uma interação de análise; não precisa de criar um loop de polling.

### Existe uma interface de linha de comandos?

R: Sim. Instale-a com um clique em **Definições → Geral → Ferramenta de linha de comandos → Comando de instalação**. Este comando adiciona `open-science` ao seu PATH, sem exigir uma instalação separada do Node.js. A CLI controla o serviço local e envia tarefas de investigação sem abrir o navegador:

```bash
# Inicie o serviço em segundo plano
open-science start --no-open

# Crie um projeto e execute uma tarefa pelo nome exato
open-science project create "Systematic review"
open-science run --project "Systematic review" \
  --prompt-file ./task.md \
  --approval-profile auto \
  --skill literature-review \
  --wait --json

# Transferir um artefacto gerado
open-science artifacts list <session-id> --json
open-science artifacts download <artifact-id> --output ./report.md
```

Consulte o [guia da CLI](../../packages/open-science/CLI.md) para ver a referência completa de comandos, os formatos de saída JSON/JSONL, os códigos de saída e as opções do serviço headless.

### Como verifico a origem de um resultado gerado?

R: Abra o artefacto gerado e selecione **Proveniência**. Escolha uma versão para examinar a identidade do conteúdo e, quando disponíveis, o código produtor, o histórico de execução, as entradas, o inventário do ambiente, o contexto da conversa produtora e as evidências do revisor. As evidências que o Open Science não conseguiu verificar são identificadas como indisponíveis.

### Posso rever um pedido anterior sem perder o restante da conversa?

R: Sim. Edite uma mensagem concluída do utilizador e reenvie-a para criar uma nova ramificação a partir daquele ponto. As interações posteriores originais continuam disponíveis, e as setas de revisão ao lado da mensagem alternam entre os caminhos.

### Os meus dados de investigação permanecem no computador?

R: Projetos, sessões, ficheiros, definições e credenciais configuradas são armazenados localmente por predefinição. O conteúdo necessário para pedidos ao modelo, investigações na web ou chamadas de conectores ainda pode ser enviado ao serviço externo selecionado; por isso, examine entradas confidenciais e as políticas do fornecedor antes de executar uma tarefa.

## Participar

O Open Science recebe relatos de bugs, propostas de funcionalidades, discussões de design, perguntas da comunidade e contribuições pelo GitHub, Discord, X e site da AIPOCH. Escolha o canal mais adequado ao seu objetivo e consulte as orientações de contribuição e o lembrete de segurança para publicações antes de partilhar detalhes do projeto.

| Canal                                                                    | Use para                                                                     |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | Bugs, falhas reproduzíveis e propostas concretas de funcionalidades          |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | Dúvidas de design, propostas para o roadmap e conversas técnicas mais longas |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | Ajuda da comunidade, coordenação entre colaboradores e conversas informais   |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | Anúncios de versões e atualizações públicas sobre o desenvolvimento          |
| [Site do Open Science](https://aipoch.com/open-science)                  | Visão geral oficial do produto e transferências                              |

Antes de abrir uma issue pública, remova de logs e capturas de ecrã chaves de API, tokens, caminhos de ficheiros privados, dados não publicados, identificadores de pacientes e outros materiais confidenciais. Consulte [CONTRIBUTING.md](../../CONTRIBUTING.md) para conhecer o fluxo de desenvolvimento.

> ⭐ **Dê uma estrela ao repositório:** se este projeto foi útil para si, agradecemos muito se puder dar uma estrela no GitHub. Este gesto incentiva a continuidade do desenvolvimento. Leva apenas um segundo, mas tem impacto significativo no projeto.

## Licença

Licença Apache 2.0 - consulte [LICENSE](../../LICENSE).

## Histórico de estrelas

<a href="https://star-history.dera.page/#aipoch/open-science&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
   <img alt="Gráfico do histórico de estrelas" src="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
 </picture>
</a>
