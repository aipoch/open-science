<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  Environnement de recherche assistée par IA pour une science reproductible — open source, local-first et indépendant des modèles.
</p>

<p align="center">
  <a href="https://aipoch.com/open-science/download">
    <img alt="Télécharger AIPOCH Open-Science" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Dernière version d’AIPOCH Open-Science" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="DOI Zenodo d’AIPOCH Open-Science" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://arxiv.org/abs/2610.17110">
    <img alt="Prépublication AIPOCH Open-Science sur arXiv : 2610.17110" src="../images/readme/arxiv-preprint.svg">
  </a>
  <a href="#performances-aux-benchmarks">
    <img alt="AIPOCH Open-Science — Résultats des benchmarks" src="../images/readme/benchmark-comparisons.svg">
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

[AIPOCH Open-Science](https://aipoch.com/open-science) est un environnement de recherche open source qui intègre l’intelligence artificielle. Commencez par une question, un article scientifique ou un fichier de données. Décrivez avec vos propres mots ce que vous cherchez à savoir, puis travaillez avec un agent d’IA pour examiner les éléments de preuve, analyser des données ou créer un graphique.

Pour comprendre comment un résultat a été obtenu, consultez les données d’entrée, le code et l’historique d’exécution disponibles. Pour partager votre travail, choisissez les branches de conversation, les versions de fichiers, les enregistrements du Notebook et les éléments de vérification à inclure dans un paquet `.science`, puis exportez-le.

### 💡 AIPOCH Open-Science v1.0.8 — Nouveautés

_4 novembre 2026_

- **Paramètres**: Des onglets par fonction organisent les informations de l'application, les diagnostics et l'aide.
- **Import de références**: Jusqu'à **100** identifiants DOI, arXiv ou PubMed, ou liens officiels d'articles, par lot, avec normalisation et dédoublonnage.
- **Synthèses d'études par IA**: Question de recherche, population, méthodes, principaux résultats et limites, avec indication de la source, texte intégral ou résumé.
- **Ressources des sessions**: Les cinq frameworks d'agents libèrent les processus des sessions terminées pour réduire l'accumulation de mémoire.
- **Modèles**: Tencent TokenHub ajoute Hy4 et des routes DeepSeek V4.1 Flash, ainsi que l'entrée d'images pour certains modèles.
- **Données scientifiques et PDF**: Rétablissement des requêtes eQTL Catalogue avec validation GRCh38 et amélioration de l'ordre de lecture et de l'extraction du texte des PDF.
- **Fiabilité**: Amélioration de la vérification des dépendances R et de la provenance des artefacts ; correction des mises à jour, téléchargements, réseau isolé et installation de Pi.

[Notes complètes v1.0.8](https://github.com/aipoch/open-science/releases/tag/v1.0.8)

<p align="center">
 <img width="1920" height="1140" alt="Bannière AIPOCH Open-Science : Science, Open to All — un banc de travail de recherche en IA scientifique open source, indépendant des modèles et auto-hébergé" src="../images/readme/open-science-banner.png" />
</p>

## Table des matières

- [Démarrage rapide](#-démarrage-rapide)
- [Paquets de recherche `.science` d’AIPOCH Open-Science](#paquets-de-recherche-science-daipoch-open-science)
- [AIPOCH Open-Science : article et citation](#aipoch-open-science--article-et-citation)
- [Résultats des benchmarks](#performances-aux-benchmarks)
- [Capacités principales](#capacités-principales)
- [Fournisseurs de modèles](#fournisseurs-de-modèles)
- [Données, autorisations et confiance](#données-autorisations-et-confiance)
- [Développement et empaquetage](#développement-et-empaquetage)
- [Questions fréquentes](#questions-fréquentes)
- [Contributeurs](#contributeurs)
- [Participer](#participer)
- [Licence](#licence)

## 🚀 Démarrage rapide

### 1. Télécharger l'application

Ouvrez la [page officielle de téléchargement](https://aipoch.com/open-science/download) et choisissez l'installateur adapté à votre ordinateur :

| Votre ordinateur                              | Choisissez                               |
| --------------------------------------------- | ---------------------------------------- |
| macOS 12+ — Apple Silicon (M1 ou plus récent) | Le DMG macOS pour Apple Silicon / ARM64  |
| macOS 12+ — Intel                             | Le DMG macOS pour Intel / x64            |
| Windows 10/11 x64                             | L'installateur Windows x64 (signé)       |
| Linux x64                                     | L'AppImage Linux x64 ou le paquet Debian |
| Linux ARM64                                   | AppImage ou paquet Debian Linux ARM64    |

Consultez la [vérification du téléchargement](../../SECURITY.md#verifying-your-download) pour les contrôles avant installation.

Les archives de la CLI autonome pour macOS, Linux et Windows incluent Node.js et s’utilisent sans Homebrew ni npm.

Sur macOS, vous pouvez aussi installer l’application avec [Homebrew](https://brew.sh) :

```bash
brew install --cask open-science
```

Pour le CLI autonome sur macOS ou Linux, utilisez le [tap AIPOCH](https://github.com/aipoch/homebrew-tap) séparé :

```bash
brew install aipoch/tap/open-science
```

Cette formule inclut Node et fonctionne sans l’application de bureau ; sa version peut différer du Cask de bureau. Voir les prérequis et mises à niveau dans le [guide du runtime autonome](../standalone-runtime.md).

Pour le CLI autonome et l’interface Web, installez le [paquet npm publié](https://www.npmjs.com/package/@aipoch/open-science) avec **Node.js 22.13.0 ou ultérieur** :

```bash
npm install --global @aipoch/open-science
open-science start --no-open
open-science url
```

Ouvrez l’URL affichée pour terminer la configuration, ou suivez le [guide de configuration du terminal](../../packages/open-science/CLI.md#first-run-setup-codex). npm prend en charge macOS ARM64/x64, Linux ARM64/x64 avec glibc et Windows x64 ; l’application de bureau n’est pas nécessaire. Conservez les dépendances facultatives npm et consultez les [prérequis Linux et les instructions de mise à jour](../standalone-runtime.md#install-from-npm). L’URL contient un jeton d’authentification ; gardez-la privée.

Sous Windows, une réinstallation conserve les données de recherche. Pour tout effacer, consultez l’[outil de réinitialisation](../../scripts/windows-reset/README.md), qui supprime définitivement les données locales après confirmation.

### 2. Terminer la configuration initiale

Suivez l’assistant : **Environnement → Emplacement des données → Environnement d’exécution de l’agent → Fournisseur de modèle → Environnement d’exécution Notebook**.

Terminez les vérifications obligatoires de l’environnement et du runtime de l’agent, puis testez la connexion au modèle. La configuration Python/R Notebook est facultative ; Notebook et l’emplacement des données restent modifiables dans les paramètres.

Les réglages d’apparence et de notifications se trouvent dans les paramètres système. La rubrique **Général** donne accès au guide d’installation et de mise à jour manuelles.

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

## Paquets de recherche `.science` d’AIPOCH Open-Science

Exportez une session de recherche terminée sous forme de paquet `.science` portable pour la revue, la transmission et l’archivage. Choisissez les branches de conversation, versions de fichiers, enregistrements Notebook et preuves de vérification à inclure, puis importez le paquet dans un autre projet ou ordinateur.

L’export et l’import sont disponibles dans l’application de bureau, les sessions Web locales et la CLI headless. Les sessions Web distantes ne peuvent pas lire ni écrire des chemins arbitraires de paquets locaux.

**Exporter → transférer → examiner**

1. Exportez une session terminée et choisissez les éléments à inclure.
2. Transférez le fichier `.science` à un collègue ou sur un autre ordinateur.
3. Importez le fichier dans un projet. **Research replay**, à droite, affiche le processus enregistré ; la conversation de gauche permet de poser des questions et de citer des étapes fixes.

Les enregistrements importés restent en lecture seule ; leur lecture n’exécute aucun code, n’appelle aucun modèle et ne restaure aucun identifiant. La première question crée une discussion modifiable associée ; utilisez **Fork to continue** pour créer une copie de travail. Une nouvelle exécution exige toujours une recette complète, les entrées nécessaires et un environnement disponible.

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

<a id="performances-aux-benchmarks"></a>

## Résultats des benchmarks

AIPOCH a évalué AIPOCH Open-Science sur des tâches allant de la recherche d’un article aux réponses sur son contenu et à l’exécution d’un plan de recherche. Les résultats ci-dessous proviennent des propres essais d’AIPOCH. Chaque score correspond à une tâche et à une configuration d’évaluation précises.

| Tâche                                | Résultat d’AIPOCH Open-Science                                                                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trouver l’article cible              | Pour **68 des 75 questions de test**, l’article cible figurait parmi les 30 premiers résultats sur LitQA2-FullText-Search (**Recall@30 de 90.67%**, gpt-6-astra).                                           |
| Répondre à partir de la littérature  | Lors d’un essai distinct sur LitQA2-FullText, Open-Science a répondu correctement à **70 questions sur 75** (**93.33% d’exactitude**, deepseek-flash avec raisonnement Max).                                |
| Produire une synthèse avec citations | Sur 100 questions de validation de ScholarQA-CS2, Open-Science a obtenu un **score composite de qualité de 0.9289/1** avec deepseek-v4-flash. Les références du test officiel utilisent d’autres questions. |
| Exécuter des workflows de recherche  | Lors d’essais locaux ASI-Bench avec le même modèle, Open-Science a obtenu **59.46** en B4 et Codex **55.45**. Les scores B2 étaient presque identiques (**56.11** et **56.09**).                            |
| Analyser des données biomédicales    | Sur BiomniBench-DA Public 50, deux modèles juges ont attribué **81.04** et **77.06** aux résultats. Leur moyenne à poids égaux était de **79.05**.                                                          |

### AstaBench — Tâches documentaires

<details>
<summary><strong>Recherche d’articles — article cible trouvé pour 68 questions sur 75</strong></summary>

AIPOCH a exécuté localement le jeu Test officiel de 75 questions de LitQA2-FullText-Search. Son Recall@30 égalait le plus élevé de l’instantané comparatif du 26 octobre 2026. Cet essai local ne constituait ni une soumission au classement officiel ni une place dans celui-ci.

![Comparaison de recherche LitQA2 d’AIPOCH Open-Science : Recall@30 local de 90.67% sur le jeu Test officiel](../images/readme/astabench-litqa2-test.jpg)

Recall@30 compte une réussite lorsque l’article cible figure dans les 30 premiers résultats ; il ne mesure pas l’exactitude des réponses. Le calcul des coûts n’a pas été uniformisé entre les essais.

</details>

<details>
<summary><strong>Questions sur le texte intégral — 70 réponses correctes sur 75</strong></summary>

AIPOCH a exécuté le jeu Test de 75 questions de LitQA2-FullText dans AstaBench v0.5.4. Le graphique classe le résultat local et les références historiques par score. La mention « #1 » désigne cette comparaison.

![Comparaison des réponses sur le texte intégral LitQA2 d’AIPOCH Open-Science : exactitude locale de 93.33%](../images/readme/astabench-litqa2-fulltext-local-comparison.png)

L’exactitude mesure la proportion de réponses correctes. Ici, 93.33% correspond à l’exactitude locale et 90.67% à une exactitude de référence historique. Le graphique de recherche ci-dessus utilise une autre métrique. Les références ont été recueillies le 28 octobre 2026 ; le meilleur score de référence a été revérifié le 2 novembre.

</details>

<details>
<summary><strong>Qualité des réponses citées — validation locale et références du test officiel</strong></summary>

Le résultat local ScholarQA-CS2 mesure la qualité des réponses avec citations sur 100 questions de Validation. Les références proviennent du jeu Test ; ces scores ne permettent donc pas un classement en confrontation directe.

![Comparaison ScholarQA-CS2 d’AIPOCH Open-Science : score composite local de Validation de 0.9289, séparé des références officielles de Test](../images/readme/astabench-scholarqa-cs2.jpg)

Le score composite utilise une échelle de 0 à 1 ; il ne représente pas le pourcentage de questions entièrement résolues.

</details>

### ASI-Bench — Suivre un plan et choisir des méthodes

Les quatre conditions demandent à l’agent d’exécuter un plan spécifié (B1), d’organiser un workflow (B2), de choisir des méthodes (B3) ou de mener une recherche malgré des informations parasites (B4). Les deux premières lignes du graphique comparent des essais locaux avec le même modèle GPT-6 Astra.

![Résultats ASI-Bench B1–B4 d’AIPOCH Open-Science avec essais locaux Codex et références publiées](../images/readme/asi-bench-b1-b4.jpg)

Open-Science a obtenu **79.35, 56.11, 59.67 et 59.46** en B1–B4 ; la référence locale Codex a obtenu **74.78, 56.09, 58.12 et 55.45**. Les scores B2 étaient presque identiques. Les autres essais publiés diffèrent par leurs instances de tâches, configurations ou méthodes de jugement.

Le score local B1 couvre 59 tâches après une exclusion liée au système de notation. Trois répétitions locales ont été rapportées pour B1/B2. B3/B4 utilisaient Open-Science v0.32.0 et un juge de substitution ; chaque score est la moyenne de trois essais de 60 tâches.

### BiomniBench-DA — Analyse de données biomédicales

Sur le jeu Public 50, le juge Gemini 3.1 Pro a attribué **81.04** aux résultats et le juge DeepSeek v4-pro **77.06**. AIPOCH rapporte leur moyenne à poids égaux, **79.05**, pour la configuration gpt-5.6-sol (xhigh).

<details>
<summary><strong>Scores des juges et références historiques — couverture de jugement variable</strong></summary>

Le graphique réunit des entrées dont la couverture par les juges diffère. La mention « #1 » décrit l’ordre de cet ensemble. Un classement selon une procédure commune nécessiterait une notation comparable pour toutes les entrées.

![Comparaison BiomniBench-DA Public 50 d’AIPOCH Open-Science montrant les scores des deux juges et leur moyenne](../images/readme/biomnibench-public50-leaderboard.png)

79.05 est un score moyen de jugement pour cette évaluation interne.

</details>

**Périmètre de l’évaluation :** ces rapports couvrent des essais locaux ou internes d’août à novembre 2026, avec les modèles et partitions indiqués ; ils n’ont pas été réexécutés pour la version actuelle. Les références sont des instantanés historiques, pas des classements en direct. Les scores de familles de benchmarks différentes ne sont pas directement comparables, et les écarts numériques ne prouvent pas une significativité statistique.

Consultez le [rapport AstaBench et ASI-Bench](https://aipoch.com/benchmark/open-science) et le [rapport BiomniBench-DA](https://aipoch.com/blog/open-science-biomnibench-da) pour les détails.

## Capacités principales

AIPOCH Open-Science combine la gestion de projets, l'exécution d'agents multi-modèles, les Notebooks Python et R, les connecteurs de données scientifiques, des versions d'artefacts immuables avec provenance, et un contrôle humain dans la boucle soumis à autorisation, dans un seul espace de travail local. L'application installée et les [notes de version les plus récentes](https://github.com/aipoch/open-science/releases/latest) font foi pour les catalogues évolutifs, les détails d'empaquetage et les options nouvellement ajoutées.

| Domaine                                       | Capacité principale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Compétences scientifiques**                 | Étendez vos recherches avec **24 compétences intégrées** et **525 compétences** du [Skills Marketplace](https://github.com/aipoch/openscience-skill-marketplace), installables et actualisables en un clic. Créez des compétences par conversation ou à partir d’un travail terminé, importez des paquets ou sources GitHub, et enregistrez des dépôts GitHub pour les réutiliser dans le processus d’import. L’enregistrement d’un dépôt n’installe pas ses compétences. Les contributions sont publiées après examen ; un import local ne les publie pas.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Connecteurs**                               | Accédez aux ressources scientifiques via **48 connecteurs intégrés**, ou ajoutez des connecteurs MCP locaux et distants personnalisés. Certaines sources intégrées sont désactivées par défaut et demandent une activation par source. Gérez les autorisations par outil et importez ou exportez les configurations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Spécialistes et délégation**                | Installez **10 spécialistes** depuis le [Specialist Marketplace](https://github.com/aipoch/openscience-specialist-marketplace), ou créez et personnalisez des spécialistes auxquels l’agent principal délègue des tâches. Les paquets s’importent et s’exportent ; les contributions sont examinées avant publication, et un import local ne les publie pas.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Modèles et backends d’agents**              | Utilisez des modèles cloud, des passerelles compatibles ou les connexions par abonnement Claude et Codex. Choisissez Claude Code, OpenCode, Codex, CodeBuddy ou Pi comme backend, avec vérification de connexion, images en entrée et réglage du raisonnement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Projets, sessions et paquets de recherche** | Organisez les projets avec sessions épinglées, branches de messages, conversations latérales et récupération d’historique. Exportez un **paquet de recherche `.science` portable** vers un autre projet ou ordinateur avec branches de conversation, versions de fichiers sélectionnées, enregistrements Notebook et preuves de vérification. Les imports sont en lecture seule, sans exécution de code ni restauration d’identifiants ; conversations latérales et signets sont exclus, et les fichiers dépendent du choix à l’exportation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Agent de revue**                            | Activez la revue automatique facultative pour examiner, dans un contexte distinct, les réponses, journaux d’exécution et éléments de preuve des fichiers associés à un tour terminé de l’agent. Obtenez des vérifications étayées indiquant réussite, avertissement ou échec, avec un nombre limité de cycles de correction par l’agent principal et de nouvelle revue en cas de problème. Les journaux de revue et l’état de résolution des problèmes sont conservés ; la revue se limite aux enregistrements disponibles pour ce tour.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Python, R, Notebooks et HPC**               | Exécutez Python, R, Notebook et shell localement avec des environnements gérés ou vos interpréteurs, en arrière-plan avec historique. L’accès SSH et les tâches Slurm nécessitent l’hôte, les logiciels, les ressources et les permissions décrits dans la FAQ sur le calcul distant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Bibliothèque de références**                | Importez et gérez références et PDF avec collections, étiquettes, liens aux projets, notes et fusion des doublons. Découvrez les références et les travaux citant un article via Semantic Scholar, téléchargez et prévisualisez les pièces jointes supplémentaires, puis importez PDF ou fichiers bibliographiques par glisser-déposer. Recherchez les textes intégraux en accès libre, lisez les PDF, extrayez figures et tableaux, et utilisez les sources de la bibliothèque pour une analyse assistée par IA. Pour les références dotées d’un DOI valide, vérifiez manuellement auprès de Crossref les rétractations ou corrections connues ; le DOI est envoyé à Crossref et, sa couverture étant incomplète, l’absence d’avis ne prouve pas que le travail n’est pas concerné. Générez des bibliographies, exportez les références en BibTeX ou RIS et les décisions de Smart Screening en CSV. Définissez manuellement l’état de lecture sur Non lu, En cours de lecture ou Lecture terminée, modifiez les références sélectionnées par lot et filtrez par état. Recherchez dans les notes personnelles depuis le champ de recherche de références existant. |
| **Fichiers scientifiques et aperçus**         | Téléversez jusqu’à **10 GiB par fichier**, organisez les fichiers du projet et prévisualisez données scientifiques, PDF, documents Office, images, code et structures moléculaires. Cette limite de téléversement ne garantit pas qu’un modèle lise tout le fichier : contexte, analyse des pièces jointes et aperçus ont leurs propres limites. Les gros fichiers nécessitent généralement une lecture ou une analyse par blocs avec du code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Artefacts et provenance**                   | Conservez des versions immuables des résultats avec code producteur, entrées, historique d’exécution, environnement et preuves de revue disponibles. Importez des artefacts depuis des dossiers autorisés ; AIPOCH Open-Science copie chaque fichier importé dans le stockage d’artefacts géré. Sur le bureau, rejouez une version admissible avec une recette complète, les entrées nécessaires et un environnement opérationnel, puis comparez les sorties et exportez les vérifications. Des preuves manquantes peuvent bloquer la vérification, et le rejeu n’établit pas la validité scientifique.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Lors d’une recherche par coordonnées dans l’eQTL Catalogue, Open-Science vérifie que les coordonnées correspondent à l’assemblage de référence GRCh38.

Importez des références, des étiquettes, des collections et des liens vers les sources depuis Zotero 10 ou une version ultérieure exécutée sur le même ordinateur. Vous pouvez choisir de copier les pièces jointes PDF locales ; l’importation est unidirectionnelle et ne modifie pas Zotero.

Ajoutez une référence à partir d’un DOI, d’un identifiant arXiv, d’un PMID, d’un PMCID ou d’un lien d’article pris en charge, ou collez jusqu’à 100 références, une par ligne. Vérifiez et modifiez une référence individuelle avant de l’enregistrer, ou sélectionnez les références à importer par lot. Les PDF en texte intégral peuvent être ajoutés séparément.

Les annotations PDF et les notes de document sont persistantes. Avec un modèle de sélection configuré, les collections intelligentes évaluent les références selon vos critères d’inclusion et d’exclusion. Les décisions de l’IA et les décisions manuelles restent distinctes pour aider la revue humaine.

En mode lecture, les agents peuvent lister, localiser et créer des notes et des marques dans les PDF liés. Les annotations PDF sont liées à la version du fichier annoté et ne se synchronisent pas entre ordinateurs.

Sur la fiche de l’article, le modèle principal configuré synthétise la question de recherche, la population étudiée, les méthodes, les principaux résultats et les limites. La synthèse précise si elle s’appuie sur le texte intégral ou sur le résumé de l’article.

L’OCR optionnelle reconnaît les pages PDF numérisées une fois le composant et les packs de langue nécessaires téléchargés. Neuf packs de langue sont disponibles : anglais, chinois simplifié, chinois traditionnel, allemand, espagnol, français, japonais, coréen et russe. Des indicateurs de couverture par page montrent quelles pages sont encore dépourvues de texte.

Les PDF traduits peuvent, en option, redistribuer le corps du texte et les légendes dans une mise en page à colonne unique axée sur le contenu, tout en conservant images, tableaux, formules et bibliographie dans leur forme d’origine, avec une correspondance entre pages source et pages de sortie. Dans les nouvelles installations, les restrictions de dossiers de Notebook et du terminal sont activées par défaut et limitent ces environnements à l’espace de travail, aux dossiers approuvés et aux fichiers requis par les outils ; ce réglage ne contrôle pas les outils natifs de l’agent ni les ordinateurs distants.

Dans l’application de bureau, la provenance des artefacts peut aussi être exportée en RO-Crate 1.1. Un paquet d’environnement lié à une version ne peut créer un environnement géré que si la capture est complète et compatible avec la plateforme cible ; ce n’est pas une sauvegarde intégrale de l’ordinateur.

Parcourez les cas de recherche sur la place de marché Sharing depuis l’accueil ou l’espace de conversation, filtrez par catégorie, recherchez par mot-clé et téléchargez les paquets depuis les fiches détaillées des cas.

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

Le développement nécessite Node.js 24. Le paquet npm publié et le tarball autonome construit localement exigent Node.js >=22.13.0. Les archives Release, la formule Homebrew et le lanceur du bureau incluent leur propre runtime.

L’application de bureau et le navigateur partagent le même service. Les applications connectées et une demande explicite de maintien en service par `open-science start` le gardent actif. Quitter la dernière application n’arrête le service que si aucune demande explicite de maintien ne subsiste.

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

La CLI autonome peut exposer ses outils de recherche à des clients MCP externes avec `open-science mcp`. Démarrez et authentifiez d’abord le service du profil sélectionné. L’adaptateur utilise les autorisations existantes de ce profil ; il ne constitue ni un bac à sable distinct ni une interface en lecture seule. Les clients connectés peuvent donc enregistrer des modifications et entraîner des coûts de modèle. Il n’expose pas d’accès shell ou RPC arbitraire, de gestion des identifiants, d’importation ou d’exportation de fichiers, de téléchargement vers un chemin ni de point de terminaison MCP HTTP distant.

## Questions fréquentes

<a id="pourquoi-le-test-de-connexion-au-modèle-échoue-t-il-"></a>

<details>
<summary>Pourquoi le test de connexion au modèle échoue-t-il ?</summary>

R : Vérifiez la clé API pour des caractères manquants ou des espaces, confirmez l'URL de base et la région, utilisez l'identifiant de modèle exact du fournisseur, et confirmez l'accès réseau et le solde du compte. Pour un abonnement Claude, réessayez la connexion navigateur partagée ou actualisez l'identifiant isolé `claude setup-token`, selon le mode sélectionné.

</details>

<a id="pourquoi-continue-est-il-désactivé-pendant-la-configuration-"></a>

<details>
<summary>Pourquoi <code>Continue</code> est-il désactivé pendant la configuration ?</summary>

R : L'étape courante n'a pas satisfait sa condition requise. Corrigez toute ligne d'environnement marquée `Action needed`, installez ou réparez l'environnement d'exécution de l'agent sélectionné, ou validez le fournisseur de modèle, selon l'étape active. La configuration Notebook est optionnelle et n'affecte que l'exécution Notebook.

</details>

<a id="comment-exécuter-des-travaux-sur-un-cluster-hpc-distant-"></a>

<details>
<summary>Comment exécuter des travaux sur un cluster HPC distant ?</summary>

R : **Remote Compute (SSH)** est toujours activé et ne doit pas être activé dans les paramètres. Enregistrez un hôte de calcul SSH sous **Paramètres → Calcul**, rendez-le disponible pour la session courante, puis utilisez le langage naturel ou `/remote-compute-ssh`. Il faut un hôte SSH accessible, une authentification valide, les droits sur les répertoires nécessaires, ainsi que les logiciels, dépendances et ressources de calcul requis. Direct SSH ne nécessite pas d’ordonnanceur ; le mode Slurm exige un environnement Slurm opérationnel et le droit de soumettre des tâches. « Toujours activé » concerne la compétence, pas la disponibilité permanente de chaque hôte enregistré.

</details>

<a id="y-a-t-il-une-interface-en-ligne-de-commande-"></a>

<details>
<summary>Y a-t-il une interface en ligne de commande ?</summary>

R : Oui. Installez la CLI autonome ou utilisez **Settings → General → Command line tool → Install command** pour contrôler une instance de bureau déjà en cours d’exécution. L’installation via npm nécessite Node.js ; Homebrew et les paquets autonomes avec environnement d’exécution intégré l’incluent. Initialisez le profil local, puis contrôlez le service et soumettez des tâches de recherche sans ouvrir de navigateur :

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

</details>

<a id="comment-inspecter-lorigine-dun-résultat-généré-"></a>

<details>
<summary>Comment inspecter l'origine d'un résultat généré ?</summary>

R : Ouvrez l'artefact généré et choisissez **Provenance**. Sélectionnez une version pour inspecter l'identité du contenu et, lorsqu'ils sont disponibles, le code producteur, l'historique d'exécution, les entrées, l'inventaire d'environnement, le contexte de conversation productrice, et les preuves du relecteur. Les preuves qu'AIPOCH Open-Science n'a pas pu vérifier sont marquées indisponibles.

</details>

<a id="puis-je-réviser-une-demande-antérieure-sans-perdre-la-conversation-qui-a-suivi-"></a>

<details>
<summary>Puis-je réviser une demande antérieure sans perdre la conversation qui a suivi ?</summary>

R : Oui. Modifiez un message utilisateur terminé et renvoyez-le pour créer une nouvelle branche à partir de ce point. Les tours ultérieurs d'origine restent disponibles, et les flèches de révision à côté du message basculent entre les chemins alternatifs.

</details>

## Contributeurs

Merci à toutes les personnes qui contribuent à AIPOCH Open-Science par leur code, leur documentation, leurs traductions, leurs signalements de bugs et leur aide à la communauté.

[Voir les contributeurs sur GitHub](https://github.com/aipoch/open-science/graphs/contributors)

[![Contributeurs à AIPOCH Open-Science](https://contrib.rocks/image?repo=aipoch/open-science)](https://github.com/aipoch/open-science/graphs/contributors)

## Participer

Aidez à améliorer AIPOCH Open-Science : signalez un bug, suggérez une fonctionnalité, posez une question ou contribuez. Choisissez un canal ci-dessous pour commencer.

| Canal                                                                    | Utilisez-le pour                                                                                   |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| [GitHub Issues](https://github.com/aipoch/open-science/issues)           | Bogues, échecs reproductibles et propositions de fonctionnalités concrètes                         |
| [GitHub Discussions](https://github.com/aipoch/open-science/discussions) | Questions de conception, propositions de feuille de route et conversations techniques plus longues |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | Aide communautaire, coordination des contributeurs et discussion informelle                        |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | Annonces de version et mises à jour de construction en public                                      |
| [Site officiel d'AIPOCH Open-Science](https://aipoch.com/open-science)   | Présentation officielle du produit et téléchargements                                              |

Avant d'ouvrir une issue publique, retirez des journaux et captures d'écran les clés API, jetons, chemins de fichiers privés, données non publiées, identifiants patients et autres éléments sensibles. Voir [CONTRIBUTING.md](../../CONTRIBUTING.md) pour le flux de développement.

> Si AIPOCH Open-Science vous est utile, ajoutez une étoile au dépôt sur GitHub.

Les capacités livrées, partielles et prévues figurent dans la [carte des capacités](../ROADMAP.md#capability-map).

## Licence

Licence Apache 2.0 — voir [LICENSE](../../LICENSE).
