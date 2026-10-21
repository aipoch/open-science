<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  Environnement de recherche assistée par IA pour une science reproductible — open source, local-first et indépendant des modèles.
</p>

<p align="center">
  <a href="https://aipoch.com/open-science/download">
    <img alt="Télécharger" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Version" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="DOI" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://arxiv.org/abs/2610.17110">
    <img alt="Prépublication AIPOCH Open-Science sur arXiv : 2610.17110" src="../images/readme/arxiv-preprint.svg">
  </a>
  <a href="#performances-aux-benchmarks">
    <img alt="AIPOCH Open-Science — meilleurs scores dans les comparaisons de benchmarks présentées" src="../../docs/images/readme/benchmark-comparisons.svg">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Plateformes macOS Windows Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-4263eb?style=flat">
  </a>
  <a href="../../LICENSE">
    <img alt="Licence Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-7950f2?style=flat">
  </a>
  <a href="https://aipoch.com/open-science">
    <img alt="Site web aipoch.com" src="https://img.shields.io/badge/website-aipoch.com-e8590c?style=flat">
  </a>
</p>

<p align="center">
  <a href="../../README.md"><img alt="English README" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh-Hans/README.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../zh-Hant/README.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="../ja/README.md"><img alt="日本語 README" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
  <a href="../ko/README.md"><img alt="한국어 README" src="https://img.shields.io/badge/한국어-d9d9d9"></a>
  <a href="../fr/README.md"><img alt="Français README" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../ru/README.md"><img alt="README en russe" src="https://img.shields.io/badge/Русский-d9d9d9"></a>
  <a href="../de/README.md"><img alt="README en allemand" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="../es/README.md"><img alt="Español README" src="https://img.shields.io/badge/Español-d9d9d9"></a>
</p>

> Ce document est une traduction de `README.md` en anglais. En cas de divergence, la [version anglaise](../../README.md) fait foi.

AIPOCH Open-Science est un environnement de recherche assistée par IA destiné aux scientifiques et aux chercheurs, développé par [AIPOCH](https://aipoch.com/open-science) selon une approche open source, local-first et indépendante des modèles. Il permet une recherche reproductible et inspectable grâce à des agents IA scientifiques, l'exécution Python et R, des connecteurs de données scientifiques, et une prise en charge multiplateforme de macOS, Windows et Linux. Créez un projet, décrivez votre objectif de recherche en langage naturel, et laissez les agents lire des fichiers, rechercher sur le web, exécuter du code, interroger des sources de données scientifiques, et produire des rapports, des tableaux et des figures avec une provenance traçable — le tout dans un seul espace de travail.

AIPOCH Open-Science prend en charge la recherche computationnelle et intensive en données dans de nombreuses disciplines, notamment l'apprentissage automatique, la statistique, les sciences de la vie, la chimie, la science des matériaux, la physique et les sciences de l'environnement. Il accompagne le processus de recherche, de la revue de littérature et de l'élaboration d'hypothèses jusqu'à l'exécution de code, l'analyse de données, la simulation, la visualisation et la production de résultats de recherche traçables.

Les sessions de recherche terminées peuvent également être exportées sous forme de paquets `.science` portables pour la revue, la transmission et l’archivage, avec les branches de conversation, versions de fichiers, enregistrements Notebook et preuves de vérification sélectionnés.

> 💡 **AIPOCH Open-Science v1.0.1** _(mise à jour en octobre 2026)_. Ce correctif ajoute l’importation de paquets `.science` en un clic depuis le navigateur, un module de mise à jour intégré plus clair et plus fiable (surtout sous Windows), l’affichage permanent des sessions en attente, des correctifs de sécurité pour la gestion des identifiants OAuth MCP, ainsi qu’une série de correctifs pour les PDF, la bibliographie et les paquets de sessions. Consultez les [notes de version 1.0.1](../../release-notes/1.0.1/fr.md) pour plus de détails. Les téléchargements correspondent toujours à la [dernière version publiée](https://github.com/aipoch/open-science/releases/latest).

<p align="center">
 <img width="1920" height="1140" alt="Bannière AIPOCH Open-Science : Science, Open to All — un banc de travail de recherche en IA scientifique open source, indépendant des modèles et auto-hébergé" src="../images/readme/open-science-banner.png" />
</p>

## Table des matières

- [Démarrage rapide](#-démarrage-rapide)
- [Visite du produit](#visite-du-produit)
- [Paquets de recherche `.science` d’AIPOCH Open-Science](#paquets-de-recherche-science-daipoch-open-science)
- [AIPOCH Open-Science : article et citation](#aipoch-open-science--article-et-citation)
- [Performances aux benchmarks](#performances-aux-benchmarks)
- [Capacités principales](#capacités-principales)
- [Fournisseurs de modèles](#fournisseurs-de-modèles)
- [Données, autorisations et confiance](#données-autorisations-et-confiance)
- [Développement et empaquetage](#développement-et-empaquetage)
- [Questions fréquentes](#questions-fréquentes)
- [Participer](#participer)
- [Licence](#licence)

## 🚀 Démarrage rapide

### 1. Télécharger l'application

Ouvrez la [page officielle de téléchargement](https://aipoch.com/open-science/download) et choisissez l'installateur adapté à votre ordinateur :

| Votre ordinateur                              | Choisissez                               |
| --------------------------------------------- | ---------------------------------------- |
| macOS 12+ — Apple Silicon (M1 ou plus récent) | Le DMG macOS pour Apple Silicon / ARM64  |
| macOS 12+ — Intel                             | Le DMG macOS pour Intel / x64            |
| Windows x64                                   | L'installateur Windows x64 (signé)       |
| Linux x64                                     | L'AppImage Linux x64 ou le paquet Debian |
| Linux ARM64                                   | AppImage ou paquet Debian Linux ARM64    |

Téléchargez depuis la [page officielle de téléchargement](https://aipoch.com/open-science/download) ; consultez la [vérification du téléchargement](../../SECURITY.md#verifying-your-download) si nécessaire.

Sur macOS, vous pouvez aussi installer l’application avec [Homebrew](https://brew.sh) :

```bash
brew install --cask open-science
```

Pour le CLI autonome sur macOS ou Linux, utilisez le [tap AIPOCH](https://github.com/aipoch/homebrew-tap) séparé :

```bash
brew install aipoch/tap/open-science
```

Cette formule inclut Node et fonctionne sans l’application de bureau ; sa version peut différer du Cask de bureau. Voir les prérequis et mises à niveau dans le [guide du runtime autonome](../standalone-runtime.md).

Sous Windows, une réinstallation conserve les données de recherche. Pour tout effacer, consultez l’[outil de réinitialisation](../../scripts/windows-reset/README.md), qui supprime définitivement les données locales après confirmation.

### 2. Terminer la configuration initiale

Suivez l’assistant : **Environnement → Emplacement des données → Environnement d’exécution de l’agent → Fournisseur de modèle → Environnement d’exécution Notebook**.

Terminez les vérifications obligatoires de l’environnement et du runtime de l’agent, puis testez la connexion au modèle. La configuration Python/R Notebook est facultative ; Notebook et l’emplacement des données restent modifiables dans les paramètres.

<table>
  <tr>
    <td width="50%"><img src="../images/readme/onboarding-environment.jpg" alt="Vérifications automatiques de l'environnement au premier lancement dans AIPOCH Open-Science"></td>
    <td width="50%"><img src="../images/readme/onboarding-model-provider.jpg" alt="Configuration du fournisseur de modèle au premier lancement dans AIPOCH Open-Science"></td>
  </tr>
  <tr>
    <td align="center"><sub>Vérifications de compatibilité hôte, de stockage et de réseau</sub></td>
    <td align="center"><sub>Validation du fournisseur, de la clé API, du point de terminaison et du modèle</sub></td>
  </tr>
</table>

### 3. Démarrer un projet de recherche

1. Cliquez sur **New project**, ouvrez une session et décrivez l’objectif de recherche, les entrées et les sorties attendues.
2. Joignez les fichiers, choisissez un modèle et un mode d’approbation, puis envoyez la tâche. Utilisez `@` pour référencer un fichier du projet ou `/` pour choisir une compétence.
3. Examinez l’activité des outils et les demandes d’approbation, prévisualisez les résultats et consultez les preuves disponibles dans **Provenance**.

> Les captures d'écran de ce README illustrent le flux de travail. Les libellés, catalogues et autres détails d'interface peuvent différer de la version que vous installez.

## Visite du produit

### De la demande de recherche au résultat traçable

Prenons une tâche bio-informatique représentative : reproduire une analyse d'expression différentielle publiée, comparer les résultats régénérés à l'article et livrer le rapport, les tableaux et les figures nécessaires à la revue. Les captures ci-dessous sont des vues représentatives de workflows AIPOCH Open-Science documentés ; elles illustrent chaque étape, mais ne proviennent pas d'une même session continue.

#### 1. Définir la tâche de recherche et ses preuves

Décrivez la question de recherche, l'article et les jeux de données sources, les méthodes ou seuils requis, les résultats attendus et les critères d'acceptation. Importez les fichiers utiles ou référencez un artefact existant du projet avec `@`, afin que l'agent parte d'entrées explicites plutôt que d'un contexte caché.

<p align="center">
  <img src="../images/readme/product-tour-task.jpg" alt="Tâche de reproduction d'article dans AIPOCH Open-Science avec la conclusion, les artefacts générés et la comparaison des sources dans un même espace de travail" width="900">
</p>

#### 2. Exécuter avec des outils scientifiques inspectables

L'agent peut associer des compétences scientifiques, des connecteurs de recherche soumis à autorisation, des recherches, des opérations sur les fichiers et du code Python ou R dans le Notebook partagé. Les figures générées peuvent être examinées à côté de la synthèse, tandis que le dossier de l'artefact rend consultables le code producteur capturé et les preuves d'exécution.

<p align="center">
  <img src="../images/readme/product-tour-execute.png" alt="Analyse bio-informatique dans AIPOCH Open-Science montrant côte à côte la synthèse, la figure générée et le code producteur capturé" width="900">
</p>

#### 3. Examiner les rapports, tableaux et figures sur place

La réponse finale résume ce qui a été reproduit, les différences observées et les limites importantes. Les rapports Markdown, tableaux CSV, images et autres artefacts de recherche générés restent liés à la session et sont aussi rassemblés dans la bibliothèque de fichiers du projet, où ils peuvent être prévisualisés à côté de la conversation et réutilisés par la suite.

<p align="center">
  <img src="../images/readme/product-tour-output.jpg" alt="Résultat de reproduction AIPOCH Open-Science avec les figures d'expression différentielle et les fichiers générés prévisualisés à côté de l'explication de l'agent" width="900">
</p>

#### 4. Relier chaque artefact à ses preuves

Chaque artefact généré est stocké dans une version immuable assortie d'une somme de contrôle. La vue **Provenance** peut présenter le code producteur et l'historique d'exécution, les entrées référencées, l'inventaire observé de l'environnement, la branche de conversation productrice et les conclusions du Reviewer propres à la version. Les preuves qui n'ont pas pu être vérifiées sont indiquées comme indisponibles plutôt que déduites.

<p align="center">
  <img src="../images/readme/product-tour-provenance.jpg" alt="Aperçu d'un artefact de recherche AIPOCH Open-Science avec l'accès Provenance permettant de retracer un résultat généré" width="900">
</p>

## Paquets de recherche `.science` d’AIPOCH Open-Science

Exportez une session de recherche terminée sous forme de paquet `.science` portable pour la revue, la transmission et l’archivage. Choisissez les branches de conversation, versions de fichiers, enregistrements Notebook et preuves de vérification à inclure, puis importez le paquet dans un autre projet ou ordinateur.

**Exporter → transférer → examiner**

1. Exportez une session terminée et choisissez les éléments à inclure.
2. Transférez le fichier `.science` à un collègue ou sur un autre ordinateur.
3. Importez le fichier dans un projet. **Research replay**, à droite, affiche le processus enregistré ; la conversation de gauche permet de poser des questions et de citer des étapes fixes.

Les enregistrements importés restent en lecture seule ; leur lecture n’exécute aucun code, n’appelle aucun modèle et ne restaure aucun identifiant. La première question crée une discussion modifiable associée ; utilisez **Create a copy to continue research** pour créer une copie de travail. Une nouvelle exécution exige toujours une recette complète, les entrées nécessaires et un environnement disponible.

Les conversations Side Chat, les signets privés de lecture et les identifiants sont exclus ; les fichiers inclus dépendent de la sélection d’export. Les relevés de vérification reçus décrivent les contrôles de l’expéditeur, pas une nouvelle exécution sur cet ordinateur. Voir le [guide des paquets `.science`](https://aipoch.com/docs/guides/research-packages/).

## AIPOCH Open-Science : article et citation

**[AIPOCH Open-Science: An Open-Source AI Research Workbench with Reproducible .science Packages](https://arxiv.org/abs/2610.17110)**

Prépublication arXiv · [v1](https://arxiv.org/abs/2610.17110v1) · Soumise le 12 octobre 2026.

Notre prépublication présente AIPOCH Open-Science, un environnement de recherche IA open source avec des paquets `.science` portables pour partager le contexte de recherche, les versions d’artefacts et les relevés de vérification. Consultez l’article pour découvrir la conception de l’échange des paquets et l’évaluation contrôlée.

Si vous utilisez AIPOCH Open-Science dans vos recherches, vous pouvez citer la prépublication :

<details>
<summary>Citation BibTeX</summary>

```bibtex
@misc{ouyang2026aipochopenscienceopensourceai,
      title={AIPOCH Open-Science: An Open-Source AI Research Workbench with Reproducible .science Packages},
      author={Wen Ouyang and Bocheng Huang and Qianyu Yao and Fei Sun and Minying Deng and Haoyue Cheng and Wenwen Zhou and Lei Mou and Yusi Wei and Jiang Li and Kun Zhu and Lei Wang and Yi Feng and Jiaheng Dai and Ke Qian and Dan Wang and Yahui Wang and Chenyi Wang and Mingsheng Lyu and Yaqiang Zhang and Ping Zheng and Chunhua Tang and Xinge Ma and Xu Zhang and Youjia Fan and Can Lu and Zhijun Dai and Man Hu and Qiqi Xie and Beinan Liu and Yuanning Guo and Yunze Liu and Jinhong Jiang and Xianjun Fu and Mingwei Zhang and Yuanji Xu and Shilin Xia and Bowen Yang and Mingjun Yu and Jingdun Xie and Xuwei Chen and Xia Zou and Yuzhou Xue and Jianguo Zhou and Chunhao Cao and Donghao Tian and Lei Huang and Jinxiao Li and Shengrong Long and Zefeng Song and Honglin Li and Jiang Luo and Wenying Jiang and Shanshan Li and Lei Dai and Ning Jiang and Ying Cai and Chaohui Li and Chunyan Peng and Hetong Zhao and Angqing Li and Chunyan Yang and Chongyang Sun and Yong Li and Xinyu Shi and Wei Dai and Ming Peng and Chen Sang and Yuanyuan Han and Desong Qiu and Haixin Miao and Jian Xu and Yi Chen and Xiaoliang Shi and Tian Shen and Teng Hu and Shuhao Wang and Yingyong Hou and Huimei Wang},
      year={2026},
      eprint={2610.17110},
      archivePrefix={arXiv},
      primaryClass={cs.SE},
      url={https://arxiv.org/abs/2610.17110},
}
```

</details>

## Performances aux benchmarks

Il s’agit de résultats historiques rapportés d’août à octobre 2026, et non d’une nouvelle évaluation de v1.0.0.

Rapports sources: [29 septembre](https://hwtgofuh6ud.feishu.cn/wiki/Kl5cwupToi901BkEaQacM1V2n7e), [12 octobre](https://hwtgofuh6ud.feishu.cn/wiki/XZSbw7L87ibjQUk98qJcuqFUnKh) (une autorisation d’accès peut être nécessaire).

### 🏆 AstaBench LitQA2-FullText-Search — 10/10 articles cibles retrouvés

AIPOCH Open-Science a obtenu **100% de recall@30** sur les dix requêtes de validation officielles avec **DeepSeek v4-flash (max)**, des spécialistes de la recherche bibliographique et des compétences. Chaque article cible figurait parmi les 30 premiers résultats. Ce score dépasse les trois résultats publics de validation cités dans le rapport, de **20 points de pourcentage** par rapport au meilleur résultat de référence de **80%**. Trois répétitions locales ont été rapportées, montrant la localisation des articles pour cet ensemble de questions scientifiques.

![AIPOCH Open-Science obtient 100% de recall@30 et 10/10 articles cibles sur la validation AstaBench LitQA2 ; test et validation utilisent des questions différentes](../images/readme/astabench-litqa2.png)

La figure comprend des résultats de test et de validation ; leur ordre est uniquement numérique. Recall@30 mesure la recherche de l'article cible, pas l'exactitude des réponses scientifiques.

### 🏆 ASI-Bench B1–B4 — Meilleurs scores affichés dans les quatre comparaisons présentées

AIPOCH Open-Science a obtenu **79.35, 56.11, 59.67 et 59.46** sur ASI-Bench B1, B2, B3 et B4 avec **GPT-6 (gpt-6-astra / xhigh)**, des spécialistes de domaine et des compétences : les valeurs affichées les plus élevées dans les comparaisons respectives retenues par les rapports. Les quatre conditions évaluent **l'exécution d'un plan complet, l'organisation d'un processus de travail, le choix autonome des méthodes et la recherche autonome avec des informations distrayantes**.

Les références locales Codex utilisant le même modèle et le même niveau de raisonnement déclaré sont de 74.78, 56.09, 58.12 et 55.45, soit des écarts numériques de **+4.57, +0.02, +1.55 et +4.01 points**. Trois répétitions locales ont été rapportées pour B1/B2 ; B3/B4 sont chacun la moyenne de trois exécutions locales de 60 tâches.

![AIPOCH Open-Science obtient 79.35, 56.11, 59.67 et 59.46 sur ASI-Bench B1–B4 ; résultats locaux et références publiques sont distingués](../images/readme/asi-bench-b1-b4.jpg)

Les exécutions locales utilisent seed31415. Le score B1 d'AIPOCH couvre 59 tâches ; une a été exclue en raison du problème d'évaluation décrit dans le rapport. B3/B4 utilisent v0.32.0 et un juge de remplacement. Les références publiques diffèrent par les instances, les configurations et l'évaluation ; l'écart B2 de 0.02 point est uniquement numérique.

### 🏆 Meilleur score dans la comparaison compilée BiomniBench-DA Public 50 — 79.05

AIPOCH Open-Science a obtenu **79.05** avec **gpt-5.6-sol (xhigh)** lors d'une évaluation interne des 50 tâches désignées BiomniBench-DA Public 50, soit le meilleur score affiché dans la comparaison compilée. Il s'agit de la moyenne à pondération égale de **81.04** pour le juge Gemini 3.1 Pro et **77.06** pour le juge DeepSeek v4-pro, décrivant l'analyse de données biomédicales de cette configuration. Voir le [rapport d'évaluation](https://aipoch.com/blog/open-science-biomnibench-da).

![AIPOCH Open-Science obtient une moyenne interne de 79.05 sur BiomniBench-DA Public 50 à partir des notes de 77.06 et 81.04 des deux juges](../images/readme/biomnibench-public50-leaderboard.png)

La comparaison mélange différentes couvertures de juges et ne constitue pas un classement officiel sous des conditions d'évaluation uniformes.

**Portée de l'évaluation :** Ces résultats locaux/internes sont déclarés par l'équipe. Arriver en tête des comparaisons présentées n'établit ni une première place officielle ni une amélioration statistiquement significative.

## Capacités principales

AIPOCH Open-Science combine la gestion de projets, l'exécution d'agents multi-modèles, les Notebooks Python et R, les connecteurs de données scientifiques, des versions d'artefacts immuables avec provenance, et un contrôle humain dans la boucle soumis à autorisation, dans un seul espace de travail local. L'application installée et les [notes de version les plus récentes](https://github.com/aipoch/open-science/releases/latest) font foi pour les catalogues évolutifs, les détails d'empaquetage et les options nouvellement ajoutées.

| Domaine                                       | Capacité principale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Compétences scientifiques**                 | Étendez vos recherches avec **23 compétences intégrées** et **525 compétences** du [Skills Marketplace](https://github.com/aipoch/openscience-skill-marketplace), installables et actualisables en un clic. Créez des compétences par conversation ou à partir d’un travail terminé, et importez paquets ou sources GitHub. Les contributions sont publiées après examen ; un import local ne les publie pas.                                                                                                                                |
| **Connecteurs**                               | Accédez aux ressources scientifiques via **36 connecteurs intégrés**, ou ajoutez des connecteurs MCP locaux et distants personnalisés. Gérez les autorisations par outil et importez ou exportez les configurations.                                                                                                                                                                                                                                                                                                                         |
| **Spécialistes et délégation**                | Installez **10 spécialistes** depuis le [Specialist Marketplace](https://github.com/aipoch/openscience-specialist-marketplace), ou créez et personnalisez des spécialistes auxquels l’agent principal délègue des tâches. Les paquets s’importent et s’exportent ; les contributions sont examinées avant publication, et un import local ne les publie pas.                                                                                                                                                                                 |
| **Modèles et backends d’agents**              | Utilisez des modèles cloud, des passerelles compatibles ou les connexions par abonnement Claude et Codex. Choisissez Claude Code, OpenCode, Codex ou CodeBuddy comme backend, avec vérification de connexion, images en entrée et réglage du raisonnement.                                                                                                                                                                                                                                                                                   |
| **Projets, sessions et paquets de recherche** | Organisez les projets avec sessions épinglées, branches de messages, conversations latérales et récupération d’historique. Exportez un **paquet de recherche `.science` portable** vers un autre projet ou ordinateur avec branches de conversation, versions de fichiers sélectionnées, enregistrements Notebook et preuves de vérification. Les imports sont en lecture seule, sans exécution de code ni restauration d’identifiants ; conversations latérales et signets sont exclus, et les fichiers dépendent du choix à l’exportation. |
| **Agent de revue**                            | Activez la revue automatique facultative pour examiner, dans un contexte distinct, les réponses, journaux d’exécution et éléments de preuve des fichiers associés à un tour terminé de l’agent. Obtenez des vérifications étayées indiquant réussite, avertissement ou échec, avec un nombre limité de cycles de correction par l’agent principal et de nouvelle revue en cas de problème. Les journaux de revue et l’état de résolution des problèmes sont conservés ; la revue se limite aux enregistrements disponibles pour ce tour.     |
| **Python, R, Notebooks et HPC**               | Exécutez Python, R, Notebook et shell localement avec des environnements gérés ou vos interpréteurs, en arrière-plan avec historique. L’accès SSH et les tâches Slurm nécessitent l’hôte, les logiciels, les ressources et les permissions décrits dans la FAQ sur le calcul distant.                                                                                                                                                                                                                                                        |
| **Bibliothèque de références**                | Importez et gérez références et PDF avec collections, étiquettes, liens aux projets, notes et fusion des doublons. Recherchez les textes intégraux en accès libre, lisez les PDF, extrayez figures et tableaux, et utilisez les sources de la bibliothèque dans les conversations pour une analyse assistée par IA. Générez des bibliographies selon le style de citation choisi et exportez les références en BibTeX ou RIS.                                                                                                                |
| **Fichiers scientifiques et aperçus**         | Téléversez jusqu’à **10 GiB par fichier**, organisez les fichiers du projet et prévisualisez données scientifiques, PDF, documents Office, images, code et structures moléculaires. Cette limite de téléversement ne garantit pas qu’un modèle lise tout le fichier : contexte, analyse des pièces jointes et aperçus ont leurs propres limites. Les gros fichiers nécessitent généralement une lecture ou une analyse par blocs avec du code.                                                                                               |
| **Artefacts et provenance**                   | Conservez des versions immuables des résultats avec code producteur, entrées, historique d’exécution, environnement et preuves de revue disponibles. Sur le bureau, rejouez une version admissible avec une recette complète, les entrées nécessaires et un environnement opérationnel, puis comparez les sorties et exportez les vérifications. Des preuves manquantes peuvent bloquer la vérification, et le rejeu n’établit pas la validité scientifique.                                                                                 |

Les annotations PDF et les notes de document sont persistantes. Avec un modèle de sélection configuré, les collections intelligentes évaluent les références selon vos critères d’inclusion et d’exclusion. Les décisions de l’IA et les décisions manuelles restent distinctes pour aider la revue humaine.

Dans l’application de bureau, la provenance des artefacts peut aussi être exportée en RO-Crate 1.1. Un paquet d’environnement lié à une version ne peut créer un environnement géré que si la capture est complète et compatible avec la plateforme cible ; ce n’est pas une sauvegarde intégrale de l’ordinateur.

## Fournisseurs de modèles

AIPOCH Open-Science est agnostique vis-à-vis des modèles au niveau produit : connectez-le à de grands fournisseurs LLM cloud, à une passerelle personnalisée, ou réutilisez un abonnement Claude ou Codex existant. La disponibilité des fournisseurs dépend actuellement du backend d'agent sélectionné et des protocoles d'API qu'il prend en charge. Les options de connexion suivantes sont disponibles :

| Mode de fournisseur             | Fonctionnement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fournisseurs cloud intégrés** | Choisissez dans la liste des fournisseurs affichée par l'application installée et authentifiez-vous avec la clé demandée.                                                                                                                                                                                                                                                                                                                                                                         |
| **Passerelle personnalisée**    | Indiquez l’URL de base, l’identifiant exact du modèle et un protocole API pris en charge par le backend choisi (Messages, Chat Completions ou Responses), puis testez la connexion. Une passerelle distante exige HTTPS et une clé API. Les adresses de boucle locale comme `localhost`, `127.0.0.1` ou `[::1]` autorisent HTTP sans clé ; des préréglages existent pour Ollama, LM Studio, llama.cpp et vLLM. Le format API par défaut ne garantit pas la compatibilité du serveur ou du modèle. |
| **Abonnement Codex**            | Sélectionnez le framework d'agents Codex, puis choisissez Abonnement Codex comme type de fournisseur.                                                                                                                                                                                                                                                                                                                                                                                             |
| **Abonnement Claude**           | Connectez-vous avec un abonnement Claude selon deux modes : **partagé** (une connexion navigateur qui stocke les identifiants dans votre profil `~/.claude` par défaut) ou **isolé** (un `claude setup-token` géré par l'application sous un `CLAUDE_CONFIG_DIR` appartenant à l'application, entièrement isolé de `~/.claude/`, avec un flux navigateur plus un repli par collage de jeton).                                                                                                     |
| **xAI (Grok) OAuth**            | Utilisez la connexion intégrée par code d’appareil xAI (Grok) OAuth. L’accès dépend du compte xAI et des protocoles pris en charge par le backend choisi ; validez la connexion dans l’application.                                                                                                                                                                                                                                                                                               |

Il y a 25 options de fournisseur prédéfinies, notamment OpenAI, Anthropic, DeepSeek, NVIDIA Build et d’autres. Les modèles et points d’accès régionaux dépendent de la version installée et du backend choisi ; consultez le sélecteur et testez la connexion dans l’application.

## Données, autorisations et confiance

AIPOCH Open-Science stocke les données de projet, les paramètres, les versions d'artefacts et les preuves de provenance sur l'ordinateur local. Les clés API sont conservées localement et utilisent le stockage sécurisé d'identifiants du système d'exploitation lorsqu'il est disponible. Les journaux sont locaux et ne sont pas téléversés automatiquement.

Un flux de données externe reste possible et doit être examiné :

- Les requêtes de modèle envoient l'invite et le contexte nécessaire au fournisseur de modèle sélectionné.
- Les recherches web et les connecteurs distants envoient leurs paramètres affichés à des services externes.
- Les connecteurs locaux peuvent exécuter des commandes de confiance sur l'ordinateur.
- L’application peut aussi contacter les serveurs de mise à jour, les catalogues du marché et les services de téléchargement d’environnements ou de modèles.
- Les pièces jointes, les références `@`, les journaux et les rapports générés peuvent contenir des données de recherche sensibles.

Choisissez le profil d'autorisation le plus étroit qui convienne à la tâche :

| Mode                 | Comportement                                                                                                                                                      | Usage recommandé                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `Ask for approval`   | Demande une autorisation pour les actions non couvertes par les autorisations limitées existantes ou les règles des outils de confiance de l’application          | Nouveaux flux, données sensibles, scripts peu familiers                   |
| `Auto-approve edits` | Utilise l’examen automatique natif du backend s’il existe ; sinon, n’autorise automatiquement que les opérations clairement peu risquées dans l’espace de travail | Travail d'édition de fichiers de confiance avec un accès externe contrôlé |
| `Full access`        | Autorise automatiquement les modifications, commandes, réseau et connecteurs                                                                                      | Travail clairement délimité, pleinement de confiance, sans surveillance   |

Le profil effectif dépend du backend et des autorisations existantes. Les règles des connecteurs, des outils et du réseau de calcul restent applicables ; vérifiez le mode effectif affiché par l’application.

Examinez les paramètres des connecteurs et l'activité des outils avant de les approuver. N'incluez jamais de clés API, de jetons d'accès, d'identifiants patients, de données non publiées ou de chemins locaux sensibles dans des captures d'écran ou des journaux d'issues publiques.

## Développement et empaquetage

AIPOCH Open-Science comprend un backend Node ordinaire et un client de bureau Electron, avec React, TypeScript, Prisma/SQLite et un runtime d’agents fondé sur ACP.

Prérequis pour le développement à partir des sources :

- Node.js 24 (voir [`.nvmrc`](../../.nvmrc)), avec npm
- Git
- L’exécution Notebook est facultative et utilise des environnements Python/R gérés par l’application ou un interpréteur compatible que vous configurez.

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

Consultez la [référence des commandes de développement et de packaging](development-quick-reference.md) et le [guide de contribution](../../CONTRIBUTING.md) pour les commandes de build et le workflow de développement.

### Modes web localhost et headless

L’interface Web fonctionne avec un backend Node ordinaire, sans Electron ni affichage graphique.

```bash
npm run dev:web
npm run pack:backend
```

L’interface Web fonctionne avec un backend Node ordinaire, sans Electron ni affichage graphique. `npm run dev:web` et `npm run dev:headless` construisent et démarrent le backend et l’interface Web, sans bureau ni icône de notification. `OPEN_SCIENCE_WEB_PORT` choisit le port (`44100` par défaut) ; Ctrl+C arrête proprement le service au premier plan.

Le développement nécessite Node.js 24. Le tarball npm autonome exige Node >=22.13.0 ; le CLI/SDK léger exige Node >=22.5. Les archives Release, la formule Homebrew et le lanceur du bureau incluent leur propre runtime.

Le bureau et le navigateur partagent le même service. Quitter le bureau arrête seulement le backend qu’il a démarré ; une connexion à un service lancé par le CLI est simplement détachée.

[CLI](../../packages/open-science/CLI.md) · [Node](../standalone-runtime.md)

### Accès distant mobile

La même UI web localhost peut être atteinte depuis un téléphone ou une tablette via l'appariement Remote.It. Appariez
un navigateur avec un code AIPOCH Open-Science à six chiffres, approuvez-le une fois sur le bureau, et l'espace de travail
reste joignable sans exposer directement le serveur en boucle locale. La confiance du navigateur est révocable, et
les changements de mode ou l'arrêt du service invalident immédiatement les sessions distantes actives.

L’ordinateur hôte doit rester allumé et connecté, avec AIPOCH Open-Science et l’agent Remote.It en cours d’exécution, et être ajouté à un compte Remote.It connecté. L’autorisation du navigateur expire et peut être révoquée ; voir le [guide du contrôle à distance](../remote-control.md).

### CLI et SDK headless

Le CLI headless et le SDK Node.js sans dépendance utilisent le même démon local, les mêmes projets, sessions,
identifiants et autorisations que les interfaces de bureau et web. L'usage détaillé vit avec le
paquet publiable, afin qu'il n'y ait qu'une seule référence de commandes à maintenir :

- [Guide CLI](../../packages/open-science/CLI.md) - installation, cycle de vie du service, automatisation des tâches,
  artefacts, formats de sortie et codes de sortie
- [Aperçu du paquet SDK](../../packages/open-science/README.md) - démarrage rapide Node.js et point d'entrée du paquet

## Questions fréquentes

### Pourquoi le test de connexion au modèle échoue-t-il ?

R : Vérifiez la clé API pour des caractères manquants ou des espaces, confirmez l'URL de base et la région, utilisez l'identifiant de modèle exact du fournisseur, et confirmez l'accès réseau et le solde du compte. Pour un abonnement Claude, réessayez la connexion navigateur partagée ou actualisez l'identifiant isolé `claude setup-token`, selon le mode sélectionné.

### Pourquoi `Continue` est-il désactivé pendant la configuration ?

R : L'étape courante n'a pas satisfait sa condition requise. Corrigez toute ligne d'environnement marquée `Action needed`, installez ou réparez l'environnement d'exécution de l'agent sélectionné, ou validez le fournisseur de modèle, selon l'étape active. La configuration Notebook est optionnelle et n'affecte que l'exécution Notebook.

### Comment exécuter des travaux sur un cluster HPC distant ?

R : **Remote Compute (SSH)** est toujours activé et ne doit pas être activé dans les paramètres. Enregistrez un hôte de calcul SSH sous **Paramètres → Calcul**, rendez-le disponible pour la session courante, puis utilisez le langage naturel ou `/remote-compute-ssh`. Il faut un hôte SSH accessible, une authentification valide, les droits sur les répertoires nécessaires, ainsi que les logiciels, dépendances et ressources de calcul requis. Direct SSH ne nécessite pas d’ordonnanceur ; le mode Slurm exige un environnement Slurm opérationnel et le droit de soumettre des tâches. « Toujours activé » concerne la compétence, pas la disponibilité permanente de chaque hôte enregistré.

### Y a-t-il une interface en ligne de commande ?

R : Oui. Installez le paquet Node autonome pour démarrer un backend indépendant. La commande installée via **Settings → General → Command line tool → Install command** contrôle une instance de bureau déjà en cours d’exécution ; cet usage ne nécessite pas de Node.js séparé. Exception : le lanceur fourni par le paquet Debian démarre le backend inclus avec son runtime Node inclus. Pour l’exemple autonome suivant, installez le paquet autonome et Node.js, initialisez le profil local puis démarrez le service :

```bash
# Démarrer le service en arrière-plan
open-science init
open-science start --no-open

# Créer un projet et exécuter une tâche par son nom exact
open-science project create "Systematic review"
open-science run --project "Systematic review" \
  --prompt-file ./task.md \
  --approval-profile auto \
  --skill literature-review \
  --wait --json

# Télécharger un artefact généré
open-science artifacts list <session-id> --json
open-science artifacts download <artifact-id> --output ./report.md
```

Voir le [guide CLI](../../packages/open-science/CLI.md) pour la référence complète des commandes, les formats de sortie JSON/JSONL, les codes de sortie, et les options de service headless.

### Comment inspecter l'origine d'un résultat généré ?

R : Ouvrez l'artefact généré et choisissez **Provenance**. Sélectionnez une version pour inspecter l'identité du contenu et, lorsqu'ils sont disponibles, le code producteur, l'historique d'exécution, les entrées, l'inventaire d'environnement, le contexte de conversation productrice, et les preuves du relecteur. Les preuves qu'AIPOCH Open-Science n'a pas pu vérifier sont marquées indisponibles.

### Puis-je réviser une demande antérieure sans perdre la conversation qui a suivi ?

R : Oui. Modifiez un message utilisateur terminé et renvoyez-le pour créer une nouvelle branche à partir de ce point. Les tours ultérieurs d'origine restent disponibles, et les flèches de révision à côté du message basculent entre les chemins alternatifs.

## Participer

AIPOCH Open-Science accueille les signalements de bogues, les propositions de fonctionnalités, les discussions de conception, les questions de la communauté et les contributions via GitHub, Discord, X et le site web d'AIPOCH. Choisissez le canal qui correspond le mieux à votre objectif, puis consultez le guide de contribution et les précautions relatives aux publications publiques avant de partager les détails de votre projet.

| Canal                                                                    | Utilisez-le pour                                                                                   |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | Bogues, échecs reproductibles et propositions de fonctionnalités concrètes                         |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | Questions de conception, propositions de feuille de route et conversations techniques plus longues |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | Aide communautaire, coordination des contributeurs et discussion informelle                        |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | Annonces de version et mises à jour de construction en public                                      |
| [Site officiel d'AIPOCH Open-Science](https://aipoch.com/open-science)   | Présentation officielle du produit et téléchargements                                              |

Avant d'ouvrir une issue publique, retirez des journaux et captures d'écran les clés API, jetons, chemins de fichiers privés, données non publiées, identifiants patients et autres éléments sensibles. Voir [CONTRIBUTING.md](../../CONTRIBUTING.md) pour le flux de développement.

> ⭐ **Ajouter une étoile au dépôt :** Si ce projet vous a été utile, une étoile sur GitHub serait grandement appréciée. Étoiler le dépôt encourage le développement continu. Cela ne prend qu'une seconde, mais cela a un impact réel sur le projet.

Les capacités livrées, partielles et prévues figurent dans la [carte des capacités](../ROADMAP.md#capability-map).

## Licence

Licence Apache 2.0 — voir [LICENSE](../../LICENSE).
