## ✨ Points forts

- **Abonnement OAuth xAI (Grok).** Un seul compte d’abonnement fonctionne avec les trois protocoles d’agent — Claude Code (Anthropic Messages), OpenCode (Chat Completions) et Codex (Responses) — via l’API xAI Responses. La connexion par code d’appareil est disponible dans les Paramètres et l’intégration, avec actualisation des jetons dans le processus principal, estimation locale du nombre de jetons Anthropic et Grok 4.6 comme modèle par défaut. (#1554, #1556)
- **Spécialistes gouvernés de la Place de marché.** Les paquets installés depuis la Place de marché portent une origine `marketplace` explicite. Le contenu de l’éditeur est en lecture seule, l’écrasement manuel par ZIP est bloqué et les mises à jour exigent une version SemVer supérieure à une référence de contenu exacte. La page des installations regroupe désormais Tous / Personnalisés / Place de marché / Intégrés et propose une vue détaillée administrée. (#1600)
- **Suivi des dépendances entre les exécutions de Notebook.** Les exécutions Python et R terminées sont analysées dans le processus avec tree-sitter WASM. Les sorties capturées à partir d’anciens états de variables portent ainsi l’état `stale`, `clear` ou `unknown`, au lieu de représenter silencieusement un état qui n’est plus actuel. (#1553)
- **Envoi immédiat en cours de tour.** L’envoi d’un message en attente pendant un tour n’interrompt plus celui-ci. Une couche de compatibilité utilise le pilotage natif des messages de suivi de chaque framework lorsqu’il est disponible et adopte un repli progressif lorsqu’il ne l’est pas. (#1566, #1593, #1592, #1590)
- **Démarrage des sessions axé sur les résumés.** Les métadonnées de requête des sessions et l’utilisation des jetons par tour sont matérialisées dans SQLite. Un démarrage normal lit les résumés et ne charge le fichier d’une session que lorsqu’elle est ouverte ou exportée, au lieu d’analyser tous les fichiers JSON de session. (#1618, #1631)

## 🚀 Nouvelles fonctionnalités

- **Fournisseur d’abonnement OAuth xAI (Grok)** avec autorisation d’appareil gérée par l’application, actualisation des jetons, estimation locale du nombre de jetons et Grok 4.6 comme modèle par défaut. (#1554, #1556)
- **Spécialistes installés depuis la Place de marché et gouvernés** avec contenu d’éditeur en lecture seule, mises à jour protégées par SemVer, détails administrés, copies modifiables et contrôles de désinstallation adaptés. (#1600)
- **Suivi des dépendances entre les exécutions de Notebook** pour Python et R, notamment les alias, mutations, classes, modèles d’objet et effets des bibliothèques scientifiques courantes. (#1553)
- **Envoi immédiat en cours de tour par suivi natif** avec replis adaptés au framework et traitement correct des réponses d’autorisation. (#1566, #1593, #1592, #1590, #1589)
- **Aperçu des artefacts dans les messages** pour les liens de fichiers gérés, images Markdown, identifiants stables d’artefact/version et cartes générées. (#1587, #1597)
- **Améliorations de l’aperçu Notebook** pour les figures, la sortie de la session actuelle, la disponibilité du Notebook et les Notebooks terminés en lecture seule. (#1605, #1564, #1545, #1599)
- **Limites de compression dans la transcription** avec des états distincts pour l’activité, la réussite, l’échec et l’annulation. (#1581)
- **Annulation clavier de l’archivage** avec le raccourci d’annulation standard du bureau. (#1595)
- **Nouvelle page À propos et entrée de commentaires** avec Centre d’aide et ressources de notes de version. (#1551, #1588)
- **Limites de jetons des modèles personnalisés** pour le contexte, l’entrée et la sortie, avec préréglages modifiables. (#1525, #1546)
- **Cycle de vie OAuth complet des Connecteurs** couvrant l’autorisation au premier enregistrement, la nouvelle tentative, la récupération, l’annulation et la finalisation ultérieure. (#1560, #1563)
- **deepseek-v4-flash-vision-exp** rejoint le catalogue des modèles DeepSeek. (#1538)

## 🔧 Améliorations

- Les métadonnées de session sont indexées dans SQLite pour le démarrage axé sur les résumés, avec moins d’analyses d’historique dans le moteur de rendu. (#1618, #1631, #1626)
- Les rafales d’outils et les événements non textuels en direct sont traités par lots pour réduire la charge IPC du moteur de rendu. (#1557, #1555)
- Les journaux du programme d’installation sont regroupés et leur conservation dans le moteur de rendu est plafonnée. (#1606)
- Les workers de la suite Vitest complète et les captures E2E des longues conversations sont plus stables. (#1625, #1627, #1628)
- Les encadrés du README v0.18.2 ont été clarifiés. (#1634)

## 🐛 Corrections de bugs

- **L’identité des Agents et la portée des capacités** sont correctement isolées. (#1617)
- **L’envoi immédiat en direct** ne laisse plus les opérations de reprise ou d’interruption bloquées. (#1613)
- **Les noyaux et onglets Notebook** corrigent le routage des entrées, les états approuvés, les limites de sortie du protocole, le rejet des appels malformés et les cas limites des environnements Python/R. (#1604, #1619, #1615, #1612, #1570, #1571, #1569, #1616, #1621, #1568, #1540, #1537)
- **Les erreurs des fournisseurs Codex et Claude** gèrent les cas incompatibles, transitoires, historiques et persistés sans rapports inutiles. (#1594, #1586, #1584, #1583)
- **Le compositeur et la file d’attente** conservent les raccourcis obliques, la sélection de Spécialiste, les messages d’admission d’exécution et les révisions de plan retenues. (#1633, #1630, #1601, #1610)
- **L’historique de délégation** signale les Sous-agents importés incomplets et évite les collisions d’activité rejouée. (#1609, #1520)
- **La mise à jour et le démarrage** préservent le transfert de téléchargement, séparent les vérifications de base de données, maintiennent le chargement continu et permettent de fermer les panneaux de récupération. (#1632, #1539, #1598, #1565, #1591)
- **Les sessions et l’espace de travail** corrigent la portée des modèles, les titres locaux, les envois inactifs simultanés, l’actualisation de l’accessibilité et la récupération du changement de Spécialiste. (#1552, #1579, #1577, #1602, #1543)
- **Les paramètres et le rejet des états périmés** préservent les préférences optimistes et refusent les snapshots obsolètes d’aperçu, de balise et d’actualisation de dossier. (#1629, #1573, #1578, #1574, #1575)
- **Les artefacts, le calcul, les Connecteurs et la navigation** améliorent la récupération, la déduplication des tentatives, les connexions MCP transitoires, l’alignement des contrôles de Spécialiste et la localisation des erreurs inattendues. (#1542, #1541, #1544, #1611, #1607, #1608, #1580)
- **Le contexte statique Notebook** reste dans son budget. (#1572)
