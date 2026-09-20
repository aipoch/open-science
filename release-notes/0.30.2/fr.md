## ✨ Points forts

- **Windows R est de nouveau fiable.** Le R géré par conda démarre de manière fiable sous Windows, l’interpréteur est de nouveau résolu après la matérialisation de l’environnement, la récupération vérifiée des noyaux préserve l’exécution, et les vérifications de recette scellée rétablissent les points d’entrée pip Windows vérifiés. (#2630, #2645, #2653, #2679)
- **Les tours du Notebook se rejouent correctement.** Les entrées d’un même tour et les imports de la bibliothèque standard sont restaurés lors du rejeu, si bien qu’une nouvelle exécution voit exactement les entrées vues par l’exécution d’origine. (#2706)
- **Les corrections du réviseur conservent leur contexte.** Les fils de retour liés ne perdent plus le contexte de correction entre les tours, et la revue automatique survit au démarrage d’une nouvelle conversation. (#2682, #2625)
- **Des preuves de littérature et de connecteurs plus propres.** Les imports PubMed séparent les noms de famille des initiales (et ne prennent plus les suffixes tels que « Jr. » pour des initiales), les chaînes de rétractation remontées via les mises à jour Crossref sont vérifiées, et Ensembl, VEP, Reactome, OLS, CellGuide, UCSC et gnomAD se comportent avec précision. (#2675, #2677, #2693, #2703, #2696, #2687, #2664, #2663, #2634)

## 🔧 Améliorations

- DeepSeek V4.1 Flash rejoint le catalogue de modèles, avec les modèles hérités des sessions préservés à travers la mise à jour (#2660), et la gamme Volcengine Ark est actualisée (#2673).
- Les indicateurs de sélection d’onglets s’animent en douceur. (#2638)
- Les cartes d’outils de littérature sont unifiées et les détails de littérature sont enrichis. (#2670)

## 🐛 Corrections

- **Notebook et calcul** — le R conda Windows démarre de nouveau et les échecs du bac à sable sont tracés (#2630) ; l’exécutable R se résout après la matérialisation de l’environnement (#2645) ; l’exécution et la récupération vérifiée des noyaux sont préservées (#2653) ; les entrées d’un même tour et les imports de la bibliothèque standard se rejouent (#2706) ; les points d’entrée pip Windows vérifiés se rétablissent pour les vérifications de reproductibilité (#2679) ; les instantanés de conversations CLI en file d’attente se réconcilient (#2676) ; aucune écriture n’a lieu pendant l’hydratation passive des conversations (#2640).
- **Littérature** — les noms de famille et les initiales d’auteurs PubMed sont séparés (#2675) et les suffixes d’auteur ne sont plus traités comme des initiales (#2677) ; les relations de rétractation Crossref « mis à jour par » sont vérifiées (#2693).
- **Connecteurs** — les recherches Ensembl indiquent l’espèce résolue (#2703) ; les requêtes de région VEP sont normalisées sur le brin direct (#2696) ; l’espèce Reactome demandée est respectée et validée (#2687) ; les échecs OLS sont préservés et la pagination des relations validée (#2664) ; les échecs de récupération de données CellGuide remontent correctement (#2663) ; les bornes UCSC sont validées et les limites gnomAD resserrées (#2634).
- **Sessions et conversations latérales** — les conversations latérales conservent leur point de montage dans l’application (#2680) et n’attendent plus la disponibilité du tour principal pour être admises (#2668) ; les sous-agents OpenCode délégués s’exécutent dans des environnements d’exécution isolés (#2652).
- **Compétences et place de marché** — les compétences d’environnement d’exécution liées à un spécialiste se préparent correctement (#2698) ; la place de marché affiche sa source en l’absence d’auteurs (#2672) ; les références de compétences OpenCode provisionnées sont lisibles (#2651).
- **Autorisations et paramètres** — l’approbation de la recherche web native est mémorisée pour la conversation (#2646) ; Paramètres reste ouvert lors de la fermeture de la navigation mobile (#2658) ; l’identité de session Go est incluse dans les sondes de fournisseur (#2662) ; le détail d’image d’origine est normalisé dans le pont de réponses (#2650) ; l’annulation reste au-dessus du panneau de paramètres (#2641) ; les mises en page des messages en ligne contextuels sont restaurées (#2674).
