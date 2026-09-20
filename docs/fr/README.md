<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  Environnement de recherche assistée par IA pour une science reproductible — open source, local-first et indépendant des modèles.
</p>

<p align="center">
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Télécharger" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Version" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="DOI" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://huggingface.co/datasets/phylobio/BiomniBench-DA">
    <img alt="N° 1 sur BiomniBench-DA Public 50" src="https://img.shields.io/badge/%F0%9F%8F%86%20%231-BiomniBench--DA%20Public%2050-f59f00?style=flat">
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
  <a href="https://discord.gg/zxQAYjReRv">
    <img alt="Discord" src="https://img.shields.io/badge/Discord-Join%20the%20Community-5865F2?style=flat&logo=discord&logoColor=white">
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

> 💡 **[AIPOCH Open-Science v0.31.1 est disponible](https://github.com/aipoch/open-science/releases/latest)** _(dernière mise à jour : septembre 2026)_. AIPOCH Open-Science v0.31.1 élargit les données scientifiques accessibles depuis une session : les outils ENA résolvent une accession publique ENA/INSDC vers ses exécutions de séquençage avec les fichiers FASTQ générés par l'archive, le connecteur Genes gagne un enrichissement GO et de voies propulsé par g:Profiler avec un arrière-plan statistique personnalisé, et les nouveaux outils NCBI résolvent les noms de taxons, examinent les assemblages du génome versionnés et recherchent des alias de séquences. Les paramètres peuvent en option connecter un service de modèles de classification dédié, et le jumelage d'accès à distance passe en haut du panneau de sécurité avec une révocation sûre des navigateurs de confiance. La stabilité est renforcée partout — les notebooks R Windows supervisent les noyaux persistants et guident la récupération réseau, les sessions OpenCode perdues sont récupérées au démarrage, et les cartes d'approbation, les aperçus de messages en attente et la liste des sessions récentes se comportent de manière plus fiable. Consultez les [notes de version les plus récentes](https://github.com/aipoch/open-science/releases/latest) pour tous les détails.

<p align="center">
 <img width="1920" height="1140" alt="Bannière AIPOCH Open-Science : Science, Open to All — un banc de travail de recherche en IA scientifique open source, indépendant des modèles et auto-hébergé" src="../images/readme/open-science-banner.png" />
</p>

## Table des matières

- [Démarrage rapide](#-démarrage-rapide)
- [Visite du produit](#visite-du-produit)
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

Ouvrez la [dernière version](https://github.com/aipoch/open-science/releases/latest), développez **Assets**, et choisissez l'installateur adapté à votre ordinateur :

| Votre ordinateur                              | Choisissez                               |
| --------------------------------------------- | ---------------------------------------- |
| macOS 12+ — Apple Silicon (M1 ou plus récent) | Le DMG macOS pour Apple Silicon / ARM64  |
| macOS 12+ — Intel                             | Le DMG macOS pour Intel / x64            |
| Windows x64                                   | L'installateur Windows x64               |
| Linux x64                                     | L'AppImage Linux x64 ou le paquet Debian |

Téléchargez depuis la page officielle des versions ; consultez la [vérification du téléchargement](../../SECURITY.md#verifying-your-download) si nécessaire.

Sur macOS, vous pouvez aussi installer l’application avec [Homebrew](https://brew.sh) :

```bash
brew install --cask open-science
```

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

## Performances aux benchmarks

### 🏆 N° 1 sur BiomniBench-DA Public 50

AIPOCH Open-Science a obtenu le meilleur score de classement dans la comparaison compilée BiomniBench-DA Public 50, avec **79.05** pour **gpt-5.6-sol (xhigh)**. Ce résultat combine un score du juge Gemini 3.1 Pro de **81.04** et un score du juge DeepSeek v4-pro de **77.06** selon une moyenne à pondération égale, plaçant AIPOCH Open-Science **n° 1** parmi les résultats Public 50 recueillis. Explorez le [jeu de données BiomniBench-DA](https://huggingface.co/datasets/phylobio/BiomniBench-DA).

<p align="center">
  <img src="../images/readme/biomnibench-public50-leaderboard.png" alt="Comparaison BiomniBench-DA Public 50 montrant AIPOCH Open-Science en première position avec un score de 79.05" width="1200" />
</p>

## Capacités principales

AIPOCH Open-Science combine la gestion de projets, l'exécution d'agents multi-modèles, les Notebooks Python et R, les connecteurs de données scientifiques, des versions d'artefacts immuables avec provenance, et un contrôle humain dans la boucle soumis à autorisation, dans un seul espace de travail local. L'application installée et les [notes de version les plus récentes](https://github.com/aipoch/open-science/releases/latest) font foi pour les catalogues évolutifs, les détails d'empaquetage et les options nouvellement ajoutées.

| Domaine                                       | Capacité principale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Compétences scientifiques**                 | Étendez vos recherches avec **23 compétences intégrées** et **525 compétences** du [Skills Marketplace](https://github.com/aipoch/openscience-skill-marketplace), installables et actualisables en un clic. Créez des compétences par conversation ou à partir d’un travail terminé, et importez paquets ou sources GitHub. Les contributions sont publiées après examen ; un import local ne les publie pas.                                                                                                                                |
| **Connecteurs**                               | Accédez aux ressources scientifiques via **24 connecteurs intégrés**, ou ajoutez des connecteurs MCP locaux et distants personnalisés. Gérez les autorisations par outil et importez ou exportez les configurations.                                                                                                                                                                                                                                                                                                                         |
| **Spécialistes et délégation**                | Installez **10 spécialistes** depuis le [Specialist Marketplace](https://github.com/aipoch/openscience-specialist-marketplace), ou créez et personnalisez des spécialistes auxquels l’agent principal délègue des tâches. Les paquets s’importent et s’exportent ; les contributions sont examinées avant publication, et un import local ne les publie pas.                                                                                                                                                                                 |
| **Modèles et backends d’agents**              | Utilisez des modèles cloud, des passerelles compatibles ou les connexions par abonnement Claude et Codex. Choisissez Claude Code, OpenCode, Codex ou CodeBuddy comme backend, avec vérification de connexion, images en entrée et réglage du raisonnement.                                                                                                                                                                                                                                                                                   |
| **Projets, sessions et paquets de recherche** | Organisez les projets avec sessions épinglées, branches de messages, conversations latérales et récupération d’historique. Exportez un **paquet de recherche `.science` portable** vers un autre projet ou ordinateur avec branches de conversation, versions de fichiers sélectionnées, enregistrements Notebook et preuves de vérification. Les imports sont en lecture seule, sans exécution de code ni restauration d’identifiants ; conversations latérales et signets sont exclus, et les fichiers dépendent du choix à l’exportation. |
| **Agent de revue**                            | Activez la revue automatique facultative pour examiner, dans un contexte distinct, les réponses, journaux d’exécution et éléments de preuve des fichiers associés à un tour terminé de l’agent. Obtenez des vérifications étayées indiquant réussite, avertissement ou échec, avec un nombre limité de cycles de correction par l’agent principal et de nouvelle revue en cas de problème. Les journaux de revue et l’état de résolution des problèmes sont conservés ; la revue se limite aux enregistrements disponibles pour ce tour.     |
| **Python, R, Notebooks et HPC**               | Exécutez Python, R, Notebook et shell localement avec des environnements gérés ou vos interpréteurs, en arrière-plan avec historique. L’accès SSH et les tâches Slurm nécessitent l’hôte, les logiciels, les ressources et les permissions décrits dans la FAQ sur le calcul distant.                                                                                                                                                                                                                                                        |
| **Bibliothèque de références**                | Importez et gérez références et PDF avec collections, étiquettes, liens aux projets, notes et fusion des doublons. Recherchez les textes intégraux en accès libre, lisez les PDF, extrayez figures et tableaux, et utilisez les sources de la bibliothèque dans les conversations pour une analyse assistée par IA. Générez des bibliographies selon le style de citation choisi et exportez les références en BibTeX ou RIS.                                                                                                                |
| **Fichiers scientifiques et aperçus**         | Téléversez jusqu’à **10 GiB par fichier**, organisez les fichiers du projet et prévisualisez données scientifiques, PDF, documents Office, images, code et structures moléculaires. Cette limite de téléversement ne garantit pas qu’un modèle lise tout le fichier : contexte, analyse des pièces jointes et aperçus ont leurs propres limites. Les gros fichiers nécessitent généralement une lecture ou une analyse par blocs avec du code.                                                                                               |
| **Artefacts et provenance**                   | Conservez des versions immuables des résultats avec code producteur, entrées, historique d’exécution, environnement et preuves de revue disponibles. Sur le bureau, rejouez une version admissible avec une recette complète, les entrées nécessaires et un environnement opérationnel, puis comparez les sorties et exportez les vérifications. Des preuves manquantes peuvent bloquer la vérification, et le rejeu n’établit pas la validité scientifique.                                                                                 |

## Fournisseurs de modèles

AIPOCH Open-Science est agnostique vis-à-vis des modèles au niveau produit : connectez-le à de grands fournisseurs LLM cloud, à une passerelle personnalisée, ou réutilisez un abonnement Claude ou Codex existant. La disponibilité des fournisseurs dépend actuellement du backend d'agent sélectionné et des protocoles d'API qu'il prend en charge. Il y a quatre façons de connecter un modèle :

| Mode de fournisseur             | Fonctionnement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fournisseurs cloud intégrés** | Choisissez dans la liste des fournisseurs affichée par l'application installée et authentifiez-vous avec la clé demandée.                                                                                                                                                                                                                                                                                                                                                                         |
| **Passerelle personnalisée**    | Indiquez l’URL de base, l’identifiant exact du modèle et un protocole API pris en charge par le backend choisi (Messages, Chat Completions ou Responses), puis testez la connexion. Une passerelle distante exige HTTPS et une clé API. Les adresses de boucle locale comme `localhost`, `127.0.0.1` ou `[::1]` autorisent HTTP sans clé ; des préréglages existent pour Ollama, LM Studio, llama.cpp et vLLM. Le format API par défaut ne garantit pas la compatibilité du serveur ou du modèle. |
| **Abonnement Codex**            | Sélectionnez le framework d'agents Codex, puis choisissez Abonnement Codex comme type de fournisseur.                                                                                                                                                                                                                                                                                                                                                                                             |
| **Abonnement Claude**           | Connectez-vous avec un abonnement Claude selon deux modes : **partagé** (une connexion navigateur qui stocke les identifiants dans votre profil `~/.claude` par défaut) ou **isolé** (un `claude setup-token` géré par l'application sous un `CLAUDE_CONFIG_DIR` appartenant à l'application, entièrement isolé de `~/.claude/`, avec un flux navigateur plus un repli par collage de jeton).                                                                                                     |

Les fournisseurs intégrés incluent OpenAI, Anthropic, DeepSeek, NVIDIA Build et d’autres. Les modèles et points d’accès régionaux dépendent de la version installée et du backend choisi ; consultez le sélecteur et testez la connexion dans l’application.

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

AIPOCH Open-Science est une application Electron construite avec React, TypeScript, Prisma/SQLite, et un environnement d'exécution d'agent basé sur ACP.

Prérequis pour le développement à partir des sources :

- Node.js 22 (voir [`.nvmrc`](../../.nvmrc)), avec npm
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

Le backend de bureau peut éventuellement servir le même renderer à un navigateur sur l'ordinateur local. Cette
fonctionnalité est désactivée par défaut et ne se lie qu'à `127.0.0.1`.

```bash
npm run build:web
npm run dev:web
```

Ouvrez l'URL authentifiée affichée par l'application. Utilisez `npm run dev:headless` pour démarrer le
backend, la barre d'état, l'environnement d'exécution de l'agent et le service web localhost sans ouvrir de fenêtre Electron.
Définissez `OPEN_SCIENCE_WEB_PORT` pour choisir un port (par défaut `44100`). Quitter explicitement
l'application arrête toujours normalement les processus d'agent et Notebook.

### Accès distant mobile

La même UI web localhost peut être atteinte depuis un téléphone ou une tablette via l'appariement Remote.It. Appariez
un navigateur avec un code AIPOCH Open-Science à six chiffres, approuvez-le une fois sur le bureau, et l'espace de travail
reste joignable sans exposer directement le serveur en boucle locale. La confiance du navigateur est révocable, et
les changements de mode ou l'arrêt du service invalident immédiatement les sessions distantes actives.

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

R : Oui. Installez-la en un clic depuis **Settings → General → Command line tool → Install command** (ajoute `open-science` à votre PATH ; aucun Node.js séparé n'est nécessaire). Le CLI contrôle le service local et soumet des tâches de recherche sans ouvrir de navigateur :

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

Les capacités livrées, partielles et prévues figurent dans la [carte des capacités](../../ROADMAP.md#capability-map).

## Licence

Licence Apache 2.0 — voir [LICENSE](../../LICENSE).
