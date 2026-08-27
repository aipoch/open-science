# Contribuer à Open Science

Merci de votre intérêt pour le projet. Ce document explique comment configurer
l'environnement, le flux de travail à suivre, et les contrôles que votre
changement doit passer avant d'être fusionné.

> Ce document est une traduction de `CONTRIBUTING.md` en anglais. En cas de
> divergence, la [version anglaise](../../CONTRIBUTING.md) fait foi.

## Code de conduite

Restez respectueux et constructif dans toutes les interactions. Partez d'une
intention bienveillante, concentrez les discussions sur le fond technique, et
aidez à faire de ce projet un lieu accueillant pour tout le monde.

## Premiers pas

### Prérequis

- [Node.js](https://nodejs.org/) 22 (voir [`.nvmrc`](../../.nvmrc)) et npm
- Git

### Installation

```bash
# Forkez le dépôt sur https://github.com/aipoch/open-science/fork, puis :
git clone https://github.com/<your-username>/open-science.git
cd open-science

# Ajoutez le dépôt d'origine comme upstream (pour rester à jour)
git remote add upstream https://github.com/aipoch/open-science.git

npm install
```

`npm install` exécute une étape `postinstall` qui génère le client Prisma et
installe les dépendances natives de l'application Electron.

### Lancer en développement

```bash
npm run dev
```

## Navigation pour les agents de code

Exécutez les commandes d'installation, de développement et de validation depuis
la racine du dépôt :

| Intention         | Commande à la racine                                       |
| ----------------- | ---------------------------------------------------------- |
| Installer         | `npm install`                                              |
| Lancer            | `npm run dev`                                              |
| Test ciblé        | `npm test -- <affected-test-path> [-t '<test pattern>']`   |
| Tests de module   | `npm run test:module -- <module-id>`                       |
| Tests impactés    | `npm run test:affected -- --base <base> --head <head>`     |
| Typecheck Node    | `npm run typecheck:node`                                   |
| Typecheck Web     | `npm run typecheck:web`                                    |
| Lint              | `npm run lint`                                             |
| Repli complet     | `npm run typecheck`, `npm run lint`, puis `npm test`       |
| UI E2E            | `npm run build:e2e`, puis `npm run test:e2e`               |
| Parcours UI       | `npm run build:e2e`, puis `npm run test:e2e:journey`       |
| Espace de travail | `npm run build:e2e`, puis `npm run test:e2e:workspace`     |
| Accessibilité     | `npm run build:e2e`, puis `npm run test:e2e:accessibility` |
| Visuel            | `npm run build:e2e`, puis `npm run test:e2e:visual`        |

Créez les worktrees Git uniquement sous le répertoire `.worktree/<name>` du
dépôt, chaque branche de changement étant basée sur la branche par défaut. Ne
supprimez pas et ne déplacez pas un autre worktree.

Obtenez une approbation explicite avant toute opération Git ou système de
fichiers destructive, toute installation de dépendance qui télécharge ou
exécute du code nouveau, toute publication de paquet ou de version, tout
traitement d'identifiants hors des flux existants du projet, ou toute écriture
externe (poussées, pull requests, issues et messages) que la tâche n'a pas déjà
demandée.

Lisez le document propriétaire existant avant de modifier l'un de ces domaines,
puis exécutez ses contrôles ciblés :

| Domaine  | Document propriétaire                                                                  | Contrôles ciblés                                                                                   |
| -------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Renderer | [Spécification de conception](../design.md)                                            | `npm run typecheck:web` ; tests ciblés sous `src/renderer/`                                        |
| Notebook | [Architecture actuelle](../PRD.md#8-current-architecture-what-is-actually-implemented) | `npm run typecheck:node` ; tests ciblés sous `src/main/notebook/`                                  |
| Settings | [Conception des paramètres](../design.md#settings)                                     | `npm run typecheck` ; tests ciblés sous `src/main/settings/` et `src/renderer/src/pages/settings/` |
| ACP      | [Architecture actuelle](../PRD.md#8-current-architecture-what-is-actually-implemented) | `npm run typecheck:node` ; tests ciblés sous `src/main/acp/`                                       |

## Structure du projet

Il s'agit d'une application Electron construite avec electron-vite, React et
TypeScript. Trois couches de processus d'exécution et un module partagé se
trouvent sous `src/` :

- `src/main/` — processus principal Electron (runtime ACP, persistance des
  sessions, artefacts, Notebook, projets, gestionnaires IPC).
- `src/preload/` — pont preload exposant un `window.api` typé au renderer.
- `src/renderer/` — interface React (pages, stores, composants).
- `src/shared/` — types et helpers partagés entre les processus.

## Flux de développement

1. Créez une branche à partir de la branche par défaut pour votre changement.
2. Effectuez le changement, en le gardant concentré et autonome.
3. Ajoutez ou mettez à jour les tests qui couvrent le comportement modifié.
4. Constituez le Test Impact Set final et exécutez-le après la dernière
   modification substantielle. Utilisez le repli complet lorsque la propriété,
   les consommateurs ou les risques ne peuvent pas être établis.
5. Ouvrez une pull request avec une description claire du changement et de sa
   motivation.

### Changements de schéma de base de données

`prisma/schema.prisma` possède les tables, colonnes, valeurs par défaut, index
et clés étrangères. Les contraintes SQLite CHECK que Prisma ne peut pas
exprimer se trouvent dans `prisma/sqlite-check-constraints.json`. Le module de
schéma d'exécution est généré ; ne l'éditez pas et n'ajoutez pas de DDL
fonctionnel au code de démarrage.

1. Modifiez le schéma Prisma et, seulement si nécessaire, le contrat CHECK
   SQLite.
2. Exécutez `npm run db:schema:generate` et examinez le schéma cible généré.
3. Ajoutez une nouvelle entrée immuable sous `src/main/database/migrations/` ;
   ne changez jamais une migration publiée ni n'étendez la liste figée de
   réparations héritées `0001`.
4. Exécutez `npm run db:schema:check` et les tests de migration avant de
   committer.

Le CLI Prisma est un outil de développement et de CI uniquement. Les
applications empaquetées exécutent le manifeste de migration versionné et ne
livrent pas le moteur Prisma migrate.

L'historique des migrations appartient à `src/main/database/`. Les tests de
module peuvent exécuter `migrateApplicationDatabase` pour créer une fixture au
schéma courant, mais les schémas historiques artisanaux, les assertions de mise
à niveau et les attentes du registre de migrations appartiennent aux tests de
migration de la base de données plutôt qu'aux suites de modules fonctionnels.

### Noms de branches

Utilisez le format `<type>/<short-description>`, avec une description en
minuscules séparée par des traits d'union :

```text
feat/project-sidebar-filter
fix/notebook-kernel-timeout
ci/ai-pr-review
```

Utilisez l'un de ces préfixes de type standard :

- `feat` — une nouvelle fonctionnalité
- `fix` — une correction de bogue
- `docs` — des changements de documentation uniquement
- `style` — formatage ou autres changements qui n'affectent pas le comportement
- `refactor` — des changements de code qui ne corrigent pas un bogue et
  n'ajoutent pas de fonctionnalité
- `perf` — des améliorations de performance
- `test` — l'ajout ou la correction de tests
- `build` — des changements du système de build ou des dépendances
- `ci` — des changements de configuration ou de scripts CI
- `chore` — du travail de maintenance non couvert par un autre type
- `revert` — l'annulation d'un changement précédent

### Style de code

- Suivez le style du code environnant — nommage, structure et idiomes.
- Le formatage est géré par Prettier. `npm run format` est optionnel ; examinez
  ses changements avant de committer, car il réécrit des fichiers dans tout le
  dépôt.
- Le lint est imposé par ESLint ; exécutez `npm run lint`.
- Entourez les chaînes visibles par l'utilisateur avec la fonction de
  traduction `t()` de `react-i18next`. Ajoutez les traductions correspondantes
  dans l'espace de noms `renderer` de `src/shared/i18n/locales/es.json`
  (espagnol), `src/shared/i18n/locales/fr.json` (français),
  `src/shared/i18n/locales/ja.json` (japonais),
  `src/shared/i18n/locales/ko.json` (coréen),
  `src/shared/i18n/locales/ru.json` (russe),
  `src/shared/i18n/locales/zh-Hans.json` (chinois simplifié) et
  `src/shared/i18n/locales/zh-Hant.json` (chinois traditionnel). Utilisez le
  texte anglais comme clé de traduction. Conservez les commentaires de code et
  la documentation en anglais.

## Politique de vérification

### Sémantique stable des commandes de test

- `npm test` exécute toujours la suite Vitest portable complète. Sa
  signification ne dépend pas de la branche courante ni des fichiers
  modifiés.
- `npm test -- <paths> [-t '<pattern>']` n'exécute que la cible explicite
  fournie par l'appelant. Elle ne découvre pas les tests impactés et ne doit
  pas être présentée comme une vérification complète.
- Le choix d'impact est une décision distincte, fondée sur le diff final. Ne
  surchargez pas `npm test` d'un comportement implicite basé sur Git diff.

### Boucle interne

Pendant l'implémentation, exécutez le plus petit test appartenant au projet qui
exerce le comportement modifié. Relancez-le à chaque changement de ce
comportement. Les résultats de boucle interne d'un état d'implémentation
antérieur ne constituent pas une preuve finale.

### Test Impact Set local final

Avant la passation, déduisez l'ensemble minimal du diff matériel final :

1. tests du comportement appartenant au Module modifié ;
2. tests de contrat des Interfaces et Adapters modifiés ;
3. tests de consommateur ou de tranche fonctionnelle lorsqu'une Interface a pu
   changer ;
4. typechecks pour chaque processus d'exécution affecté ;
5. `npm run lint` lorsque le code source ou une configuration lintée a changé ;
6. contrôles de plateforme, de persistance, de migration, de build ou E2E pour
   les risques qui peuvent être exercés localement.

La seule proximité de répertoire n'est pas une preuve d'impact. Si un fichier
mélange plusieurs responsabilités, traitez-le comme affectant une Interface ou
utilisez le repli complet.

`test:module` ne prend en charge que les identifiants de Module déclarés dans
`scripts/ci/module-impact.json`. Il exécute les tests propriétaires, de contrat
et de consommateurs représentatifs sélectionnés pour ce Module ; ce n'est pas
une vérification aval complète pour un changement d'Interface. Utilisez
`test:affected` ou le plan PR Gate à head exact lorsqu'une Interface ou ses
consommateurs ont pu changer.

### Repli complet

Exécutez `npm run typecheck`, `npm run lint` et `npm test` lorsque l'un de ces
cas s'applique :

- le Module propriétaire, l'Interface changée ou les consommateurs ne peuvent
  pas être établis ;
- des entrées de validation globales changent, y compris les métadonnées de
  paquet, la configuration TypeScript/Vitest/build, le workflow ou le
  classifieur PR Gate, ou le routage de propriété, de consommateur, de capacité
  ou de repli dans le manifeste d'impact des modules ;
- le changement traverse plusieurs domaines d'exécution sans carte d'impact
  démontrée ;
- un workflow de candidat de version ou un mainteneur demande explicitement la
  suite locale complète.

Le repli complet est un mécanisme de sécurité, pas un prérequis inconditionnel
pour chaque pull request. Les contributeurs ne sont pas tenus de reproduire
localement toutes les voies CI par système d'exploitation.

Modifier uniquement `testFiles` dans un Module déjà possédé ne déclenche pas le
repli complet. Exécutez les tests de validation du manifeste,
`npm run test:module -- <module-id>`, les typechecks des processus affectés et
le lint ; la CI à head exact reste l'autorité pour les suites portables et
plateforme complètes.

### Autorité CI et preuves

PR Gate classifie le diff final base-to-head à partir d'entrées de confiance,
ajoute des voies consommateur et de risque plateforme, et bascule en échec
fermé vers le plan complet en cas de propriété inconnue ou ambiguë. Les
contrôles sélectionnés sont bloquants ; les contrôles non sélectionnés sont
signalés comme ignorés plutôt que traités comme une preuve.

La passation finale doit lister les changements matériels, relier chaque
comportement affecté à son contrôle appartenant au projet et à son résultat
final (`comportement -> commande -> résultat`), expliquer pourquoi les
consommateurs ou les voies plateforme ont été inclus ou exclus, et identifier
les risques non couverts. Indiquez que les contrôles ont été exécutés après la
dernière modification substantielle. Ne marquez le changement comme vérifié
qu'après qu'une revue indépendante confirme que cette correspondance couvre
l'état final.

## Messages de commit

Chaque sujet de commit doit suivre Conventional Commits avec une portée :

```text
<type>(<scope>): <description>
```

Ce format est vérifié pour chaque commit d'une pull request.

Utilisez les mêmes préfixes de type standard listés sous [Noms de
branches](#noms-de-branches). La portée doit être un nom court, séparé par des
traits d'union, de la zone affectée, commençant par une minuscule ; les
majuscules sont autorisées à l'intérieur pour les noms propres et termes
techniques (par exemple `macOS`).

```text
feat(projects): add sidebar filter
fix(notebook): prevent kernel startup timeout
ci(review): unify automated AI reviews
```

- Rédigez une description claire, à l'impératif, commençant par une minuscule ;
  les majuscules sont autorisées à l'intérieur pour les noms propres et termes
  techniques (par exemple `detect user-installed CRAN R on Windows`).
- Gardez le sujet concis ; utilisez le corps pour expliquer le _pourquoi_
  lorsqu'il n'est pas évident d'après le diff.
- Ajoutez `!` avant le deux-points et un pied de page `BREAKING CHANGE:` pour
  les changements incompatibles, par exemple
  `feat(api)!: remove legacy session endpoint`.

## Pull requests

- Utilisez le même format `<type>(<scope>): <description>` pour le titre de la
  pull request, par exemple `feat(projects): add sidebar filter`.
- Référencez toute issue liée dans la description.
- Pour un travail qui change le comportement, utilisez une description concise
  afin que les relecteurs puissent évaluer l'intention, la portée et la
  validation avant de lire le diff. Utilisez la structure suivante lorsqu'elle
  s'applique :

  ```md
  ## Problem

  ## Proposed change

  ## Scope and non-goals

  ## Acceptance criteria and validation

  ## Review focus
  ```

- Pour des changements d'architecture, des flux de données, des transitions
  d'état ou des interactions entre plusieurs composants, envisagez d'ajouter un
  diagramme Mermaid lorsqu'il rend la conception plus facile à comprendre et à
  relire.
- Les petites documentations, maintenances et corrections étroitement ciblées
  peuvent utiliser un résumé concis, mais doivent tout de même indiquer le
  comportement attendu et la validation.
- Incluez la correspondance de preuves finale de la [Politique de
  vérification](#politique-de-vérification), indiquez que les contrôles listés
  ont été exécutés après la dernière modification substantielle, et signalez
  les risques non couverts.
- Conservez des PR raisonnablement petites et ciblées pour faciliter la revue.
- Assurez-vous que le Test Impact Set final, ou le repli complet lorsqu'il est
  requis, passe.
- Une fois les contrôles de la pull request passés, fusionnez-la directement
  en utilisant **squash merge uniquement**. Ne mettez pas à jour la branche
  seulement parce que `main` a avancé ; mettez-la à jour en cas de conflits de
  fusion ou si un mainteneur le demande. Le sujet du commit squash doit
  conserver le format Conventional Commit du titre de la pull request.
- Les changements non documentaires fusionnés dans `main` déclenchent le
  [workflow Nightly](../../.github/workflows/nightly.yml), qui exécute une
  vérification post-fusion et une certification de paquets multiplateforme sur
  le commit résultant.

## Signaler des problèmes

Lorsque vous déposez un rapport de bogue, incluez :

- Ce que vous attendiez et ce qui s'est réellement produit.
- Les étapes pour reproduire.
- Votre système d'exploitation et la version de l'application.
- Les journaux ou captures d'écran pertinents, s'ils sont disponibles.

## Publier le paquet npm

Les mainteneurs doivent suivre le [guide de publication du paquet
npm](../npm-release.md). Les versions du paquet npm utilisent des tags
`npm-v*` et sont publiées via le workflow protégé `Publish npm package`.

## Licence

En contribuant, vous acceptez que vos contributions soient concédées sous la
[licence Apache 2.0](../../LICENSE), la même licence que celle qui couvre ce
projet.
