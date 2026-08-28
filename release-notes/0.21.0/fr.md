## ✨ Points forts

- **Framework d'agent CodeBuddy.** Un quatrième framework d'agent sélectionnable rejoint Claude Code, OpenCode et Codex — installé et géré depuis les réglages sans connexion séparée, exécuté via les fournisseurs de modèles déjà configurés, avec les compétences, notebooks et connecteurs routés par le même runtime géré par l'application. (#1831, #1849)
- **Annotations.** Sélectionnez du texte dans la conversation, l'activité des outils ou les aperçus de fichiers — ou un point sur une image — et envoyez-le à l'agent comme contexte. Les annotations survivent aux redémarrages, sont préservées lors de l'édition et du renvoi, et apparaissent sous forme de cartes dans la conversation. (#1815, #1821, #1826, #1837)
- **Catalogues OpenCode étoffés.** OpenCode Go passe à 21 modèles et OpenCode Zen à 40, couvrant les dernières familles Claude, GPT, Grok, GLM, DeepSeek, Kimi et Qwen, avec métadonnées d'endpoint, de fenêtre de contexte et de raisonnement par modèle. (#1807)
- **Marqueurs de changement de configuration.** Quand le framework, le modèle ou l'effort de raisonnement d'une session change entre deux tours, la conversation affiche un séparateur discret avec la nouvelle configuration — donnant une raison visible aux réponses suivantes qui se lisent différemment. (#1825, #1833)

## 🚀 Nouveautés

- **Framework d'agent CodeBuddy** — runtime ACP géré par l'application, épinglé en version et sans connexion ; le pilotage de session, les changements de modèle et d'effort, la compaction, l'entrée d'images et l'usage par appel sont adaptés, tandis que compétences, notebooks et connecteurs restent sur le routage géré par l'application. (#1831, #1849)
- **Annotations de texte et d'image** — annotez des sélections sur les surfaces de conversation, d'activité, de clarification et d'aperçu de fichiers ; les annotations portent leur source, se révèlent à la demande, survivent aux éditions et renvois, et se sérialisent dans les messages de l'agent et des conversations latérales. (#1815, #1821, #1826, #1837)
- **Catalogues OpenCode Go et Zen étoffés** avec une surcharge d'endpoint au niveau du modèle pour connecter correctement les modèles à protocoles mixtes. (#1807)
- **Authentification SSH par mot de passe sous Windows** pour les hôtes de calcul distant, avec stockage sécurisé par Windows. (#1805)
- **Marqueurs de changement de configuration d'agent** dans la chronologie de conversation. (#1825, #1833)
- **Les lignes de chargement de compétence affichent le document** — déplier un chargement terminé rend ses instructions en Markdown au lieu de JSON brut. (#1812)
- **Place de marché en grille de cartes** avec puces de filtrage Officiel, Communauté et mises à jour disponibles. (#1840)
- **Centre de messages repensé** — les icônes encodent à la fois ce qui s'est passé et si cela attend une action de votre part, avec des états lu/non-lu plus clairs et des aperçus sur deux lignes. (#1841)
- **32 icônes d'avatar de spécialiste supplémentaires** couvrant science, recherche, rôles et ingénierie. (#1838)

## 🔧 Améliorations

- Les demandes de permissions Chromium venant du renderer sont refusées par défaut, réduisant la surface exploitable par un code renderer compromis. (#1817)
- Les détails d'exécution des travaux de calcul distant persistés sont protégés par le stockage sécurisé de l'OS, avec un avertissement clair quand la protection est indisponible. (#1818)
- Les arguments IPC de calcul sont strictement validés avant usage. (#1820)
- Les délais de requête des connecteurs ne sont plus retentés : une requête bloquée échoue une seule fois avec une explication claire de l'échéance au lieu de trois tentatives de 30 secondes. (#1829)
- L'annulation d'un sondage de connecteur prend effet immédiatement au lieu d'attendre la fin du délai. (#1830)
- Les sessions de re vision bornent la taille des journaux capturés, empêchant une sortie d'outil surdimensionnée de bloquer l'application. (#1824)
- L'invite d'étoile GitHub respecte un refroidissement inter-projets et apparaît bien moins souvent. (#1813)
- Les traductions japonaises ont reçu une passe de terminologie et de cohérence. (#1823)
- L'erreur de démarrage des réglages utilise la notice d'erreur standard avec réessai. (#1835)

## 🐛 Corrections

- **Calcul distant** — une session reste active tant que ses travaux distants tournent, au lieu de s'afficher terminée trop tôt (#1803), et les échecs d'envoi inattendus sont enregistrés avec leur vraie cause (#1811).
- **Artefacts** — les fichiers générés par les tâches/CLI et les continuations de délégation conservent leur provenance d'exécution et n'échouent plus la finalisation. (#1802, #1810)
- **Sessions** — les sessions Claude vides créées par branchage sont supprimables (#1806), et la carte de survol de session s'aligne sur sa ligne et permet le renommage en ligne (#1843, #1845).
- **Fenêtre de contexte** — quand les détails par appel ne couvrent qu'une partie de l'historique après un changement de framework ou de modèle, une notice en ligne révèle la couverture au lieu de masquer des tours en silence. (#1828)
- **Notebook** — les courses d'exécution en file ne produisent plus de résultats de cycle de vie incohérents comme des exécutions marquées échouées après une réparation réussie ou des interruptions en double. (#1832)
- **Plans** — une session restaurée qui ne peut pas lire son plan affiche une notice de nouvelle tentative visible au lieu d'une carte de plan manquante silencieuse. (#1834)
- **Fichiers** — les échecs de retrait d'accès de répertoire et de lignée d'artefact apparaissent en ligne avec réessai au lieu d'échouer en silence. (#1842)
- **Espace de travail** — les aperçus de fichiers se ferment en une seule pression de `Cmd/Ctrl+W` (#1804).
