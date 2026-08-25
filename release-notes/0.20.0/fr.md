## ✨ Points forts

- **Références de session (`#`).** Référencez une autre session directement dans le composeur. La puce insérée permet de revenir à la session cible, et l'agent obtient un accès en lecture au transcript visible de la session référencée pour ce tour. (#1682)
- **Recommandations des conversations latérales dans un tour principal en cours.** Les conseils d'une conversation latérale atteignent désormais l'agent principal pendant que son tour s'exécute, via le canal de suivi natif de chaque framework, au lieu d'attendre le prochain message utilisateur. (#1624)
- **Longs collage de texte en pièces jointes.** Les collage de texte brut de plus de 10 000 caractères ou 300 lignes deviennent une pièce jointe gérée avec une carte dans le composeur ; Afficher dans le champ de texte restaure le texte exact et la position du curseur, et l'annulation remet la pièce jointe en attente. (#1678)
- **Performance des longues sessions.** Le rendu du transcript est borné et indexé avec images en cache et préchargement avant le bord de défilement, l'historique du notebook se charge progressivement par pages, le démarrage diffère les sondes de transcript et d'exécution, et le panneau d'utilisation met sa projection en cache — les longues sessions s'ouvrent et défilent fluidement. (#1636, #1654, #1667, #1651, #1637, #1658)

## 🚀 Nouveautés

- **Références de session (`#`)** dans le composeur, avec accès en lecture limité au tour pour la session référencée et puces cliquables dans les brouillons et les messages envoyés. (#1682)
- **Recherche de session par numéro dans la recherche globale**, avec les correspondances exactes en tête et des métadonnées de numéro stables sur les lignes de session. (#1691)
- **Recommandations des conversations latérales injectées dans les tours principaux en cours**, avec relais durable vers le prochain tour utilisateur lorsque l'injection est impossible. (#1624)
- **Progression d'installation des paquets** pour les environnements de notebook, affichant le nombre demandé, le temps écoulé et une indication d'attente dans l'activité de session. (#1650)
- **Carte Scénarios de modèles** dans les Paramètres, regroupant les politiques de modèle de sous-agent, de relecteur et de vision dans un accordéon, aux côtés d'une section modèle principal fusionnée. (#1645)
- **Navigation de place de marché simplifiée** — Installés devient l'accueil de gestion avec une seule action Parcourir la place de marché, et la place de marché est une route distincte avec un chemin de retour explicite. (#1644)
- **Notes de version localisées dans le dialogue de mise à jour** — les notes de version dynamiques suivent la langue d'interface choisie. (#1664)

## 🔧 Améliorations

- Les images du transcript sont mises en cache comme ressources bornées du renderer, et le lot suivant est préchargé avant le bord de défilement. (#1636, #1654)
- Les projections de transcript des longues sessions sont indexées, gardant un rendu linéaire à mesure que les conversations grandissent. (#1667)
- L'historique d'exécution du notebook se charge progressivement par pages, avec ancrage du défilement et cache de pages borné. (#1651)
- Le démarrage n'ouvre plus le transcript de la dernière session et n'attend plus les sondes d'exécution avant d'entrer dans l'accueil. (#1637)
- Le panneau d'utilisation réutilise une projection fraîche pendant dix minutes au lieu de se recharger à chaque visite. (#1658)
- L'historique de relecture se charge via des requêtes groupées et indexées. (#1689)

## 🐛 Corrections

- **Les refus d'autorisation sont désormais respectés.** Après un refus, l'agent est informé qu'il n'a pas d'autorisation pour cette opération et ne doit pas la réessayer ni la contourner par un autre moyen dans le tour courant. (#1653)
- **Les environnements de notebook** exposent les cibles d'exécution de façon cohérente, protègent de la suppression les environnements encore liés à une session, gardent des erreurs REPL concises pour les agents, valident les préfixes d'environnements interrompus et rejettent les noms de paquets ressemblant à des indicateurs dans les environnements nommés. (#1671, #1672, #1670, #1688, #1687)
- **La provenance** capture l'exécution productrice du répertoire de transfert et accepte les producteurs des branches ancêtres. (#1659, #1660)
- **La finalisation des artefacts** conserve une exécution terminée après un conflit de sauvegarde ultérieur. (#1647)
- **Les connecteurs** gèrent les identifiants versionnés et les dépassements de délai avec des échecs plus clairs, et affichent des erreurs de passerelle actionnables. (#1639, #1663, #1655)
- **Sessions et espace de travail** publient les mises à jour des sessions de conversation latérale, réveillent l'agent principal après le règlement d'un travail délégué, relient les erreurs de reprise Codex aux Paramètres de l'agent, gardent la barre latérale mobile utilisable et empêchent les soumissions en double lors de l'embarquement. (#1642, #1532, #1676, #1668, #1674)
- **L'analyse des dépendances Python** limite l'incertitude aux noms définis conditionnellement, restaurant un suivi précis entre exécutions. (#1640)
- **Les sessions CLI concurrentes** préservent les liaisons d'hôtes de calcul sélectionnées. (#1661)
- **Les Paramètres** alignent les contrôles d'installation de paquets sur la propriété d'exécution et stabilisent le rafraîchissement de l'usage des jetons. (#1648, #1638)
- **Les événements du renderer** sont livrés de façon fiable et les abonnés défaillants sont isolés. (#1646, #1666)

## ⚠️ Changements cassants

- **Les champs de résultat du SDK hôte sont en camelCase.** Les résultats du SDK hôte destinés aux agents qui utilisaient des champs snake_case (reçus de délégation, cadres, lignée, descripteurs d'aide) utilisent désormais camelCase. Les compétences et scripts lisant ces champs doivent passer aux noms camelCase ; la sortie structurée appartenant à l'utilisateur est inchangée. (#1643)
