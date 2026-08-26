## ✨ Points forts

- **Détails de session générés et éditables.** Les nouvelles sessions reçoivent un titre et une description générés à partir du premier message, modifiables à tout moment — les cartes de l'accueil montrent désormais le sujet de chaque session au lieu de premières lignes tronquées. (#1721)
- **Usage détaillé par appel.** Lorsque le framework rapporte suffisamment de données, les jetons de chaque appel de modèle et sa part de fenêtre de contexte sont enregistrés, et la vue Appels du dialogue de fenêtre de contexte devient un graphique par appel avec panneau de détails épinglé et groupement par tour, modèle ou framework. (#1718, #1734, #1740)
- **Import/export de configurations client MCP.** Importez le JSON standard `mcpServers` utilisé par les autres hôtes MCP (les fichiers multi-serveurs permettent d'en choisir un) et exportez soit un connecteur Open Science, soit une configuration client MCP — les identifiants et en-têtes exportés sont toujours remplacés par des espaces réservés `${NAME}`. (#1698)
- **Rétablissement de brouillon dans le composeur.** Le raccourci standard de rétablissement (`Cmd/Ctrl+Shift+Z`) réapplique le dernier état de brouillon annulé, complétant l'historique unifié partagé par le texte, les collage et les pièces jointes. (#1699, #1694)

## 🚀 Nouveautés

- **Détails de session générés et éditables** — une tentative de génération par session via un exécuteur restreint sans outils, une boîte de dialogue d'édition avec compteurs de caractères qui supplante une génération en cours, et un modèle de détails de session configurable. (#1721)
- **Détails d'usage par appel de modèle** — enregistrements d'appels validés persistés par tour, avec les modes Tours et Appels et le groupement dans le dialogue de fenêtre de contexte. (#1718)
- **Graphique de fenêtre de contexte par appel** — barres empilées entrée/cache/sortie par appel, résumé à trois métriques, panneau de détails épinglé, palette discret du système de design et couloirs de tours ; la projection d'historique est différée jusqu'à l'ouverture du dialogue. (#1734, #1740, #1745)
- **Transfert de configurations MCP** — import/export des configurations client MCP standard avec espaces réservés pour les identifiants, sélection multi-serveurs et diagnostics clairs pour les formats non pris en charge. (#1698)
- **Historique de rétablissement des brouillons du composeur** avec restauration du curseur et gestion du cycle de vie des téléversements mis en attente. (#1699, #1694)
- **Diagnostics de requêtes HTTP corrélés** — chaque requête web et tâche reçoit un identifiant de corrélation qui relie les journaux de commande, de session et d'exécution, y compris les rejets à la frontière. (#1703)

## 🔧 Améliorations

- Zhipu AI (GLM) ajoute le modèle GLM-4.5-Air. (#1762)
- Zhipu AI (GLM) ajoute le modèle GLM-5.3. (#1766)
- Les téléchargements sont validés et les liens externes classés de façon cohérente avant ouverture. (#1744)
- Tout le réseau — y compris les téléchargements et les requêtes dérivées — respecte uniformément le mode proxy configuré. (#1753)
- La projection d'historique de fenêtre de contexte est différée jusqu'à l'ouverture du dialogue, les rafales d'actualisation d'instantanés de notification sont fusionnées et l'analyse des compétences utilisateur au démarrage est différée, raccourcissant le démarrage. (#1745, #1702, #1700)
- La persistance de l'aperçu des fichiers évite les écritures et lectures redondantes. (#1747)
- Les échecs MCP de Codex consignent leurs causes sous-jacentes pour un diagnostic plus rapide. (#1736)
- Les imports de compétences GitHub bloqués peuvent être interrompus. (#1714)

## 🐛 Corrections

- **L'historique de conversation** reste intact lors d'écritures concurrentes — la propriété du graphe est appliquée avant les écritures d'autorité, les identifiants de framework inconnus sont préservés et les projections validées. (#1746, #1722, #1726)
- **Les tours interrompus** conservent leurs enregistrements d'usage, et les sessions Codex interrompues reprennent sans échec de données vides. (#1738, #1706)
- **Le calcul distant** annule les approbations en attente des sessions supprimées, annule le travail du poller à l'arrêt et renforce la coordination des tâches distantes. (#1716, #1737, #1724)
- **Les connecteurs** préservent les entrées d'identifiants scalaires, valident les arguments des outils intégrés, bornent les ressources de réponse de l'analyseur et restreignent les URL d'autorisation OAuth. (#1754, #1725, #1720, #1695)
- **Les fournisseurs** orientent les échecs de connexion vers les paramètres, et l'achèvement d'artefact Responses produit des diagnostics au lieu d'échecs silencieux. (#1723, #1756)
- **Le composeur et la file** masquent l'espace réservé pendant la composition IME et précisent la durée de vie transitoire de la file. (#1739, #1713)
- **Le notebook** documente le chargement des modules CommonJS, compacte les erreurs REPL dans le contexte d'état, et les mises à jour simultanées des paramètres d'exécution ne sont plus en conflit. (#1755, #1751, #1707)
- **La délégation** valide les requêtes de délégation avant admission, et les invocations d'inférence restreintes sont isolées. (#1735, #1732)
- **Les sessions et projets** préservent les horodatages d'activité à l'archivage, des horodatages de mise à jour monotones, le cycle de vie des soumissions de relecteur engagées, et les plans de session acceptent des questions de clarification structurées. (#1719, #1711, #1709, #1701)
- **L'autorisation d'appariement de l'accès distant** est renforcée. (#1729)
- **Le renderer** récupère l'état des tâches asynchrones et des fournisseurs et renforce les interactions de cycle de vie et de fichiers. (#1728, #1743)
- **Les formulaires de clarification** appliquent les invariants de schéma pour que les réponses personnalisées restent valides. (#1742)
- **Les ressources** appliquent les limites de fournisseurs et d'opérations sur fichiers. (#1731)
