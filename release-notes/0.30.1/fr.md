## ✨ Points forts

- **Examinez les mises à jour de compétences comme un vrai diff.** Les aperçus de mise à jour passent par une visionneuse de diff de source partagée — en-têtes de fichiers avec compteurs de changements, gouttière de numéros de ligne, rails de suppression rouges en pointillés et rails d’ajout verts pleins, coloration syntaxique optionnelle et replis lisibles pour les correctifs malformés ou trop volumineux. (#2632)
- **Les conversations latérales démarrent en brouillons avec le bon modèle.** Les nouvelles conversations latérales ouvrent immédiatement un brouillon vide, héritent du modèle et de l’effort de raisonnement courants de la conversation principale, puis appliquent votre propre sélection à l’envoi suivant ; les brouillons vides intacts sont supprimés automatiquement. (#2598)
- **Un utilitaire de réinitialisation autonome pour Windows.** Lorsque des données endommagées survivent à une réinstallation, un outil en ligne de commande guidé liste les emplacements résolus des données, de la configuration, du profil et des caches des environnements d’exécution authentifiés, refuse les cibles non sûres et ne supprime qu’après la saisie exacte d’une confirmation — les environnements d’exécution en cours de fonctionnement bloquent le nettoyage. (#2626)
- **De petits conforts dans tout l’espace de travail.** Les sélecteurs d’étiquettes et de ressources gagnent la recherche et la création au clavier, la licence du projet est affichée pendant l’installation, les paquets `.science` peuvent emporter les PDF de littérature que vous sélectionnez, et les aperçus d’exécution et les boutons partagent un même langage de mouvement. (#2600, #2591, #2637, #2639)

## 🚀 Nouveautés

- **Visionneuse de diff partagée avec surbrillance** — réutilisable dans toute l’application et d’abord intégrée dans la boîte de dialogue de mise à jour des compétences, avec des séparateurs traduits pour le contexte omis et des libellés pour lecteur d’écran qui conservent le sens du changement. (#2632)
- **Brouillons de conversations latérales et modèles de conversation** — les brouillons contenant du texte ou des annotations survivent à la navigation, l’intention d’utiliser la valeur par défaut du fournisseur survit aux redémarrages et aux échecs de reprise, et le menu d’envoi ne paraît plus indisponible avec une zone de composition vide. (#2598)
- **Utilitaire autonome de réinitialisation des données Windows** — fondé sur PowerShell et référencé depuis la documentation ; il valide chaque cible avant la suppression, détache les liens descendants sans les suivre, traite la configuration en dernier et garde les erreurs visibles. (#2626)
- **Sélecteurs d’étiquettes avec recherche et création au clavier** dans les sélecteurs de ressources (#2600), **présentation de la licence pendant l’installation** (#2591), des **PDF de littérature sélectionnables dans les paquets `.science`**, une **carte d’aperçu d’exécution partagée et animée** (#2637), et un **mouvement des boutons et un retour d’action unifiés** (#2639).

## 🔧 Améliorations

- Les fournisseurs incompatibles sont testés sur leur propre chemin au lieu de perturber le chemin actif, et les passerelles locales sans clé sont désormais autorisées. (#2569)
- L’approbation de lecture web est mémorisée pour le reste de la conversation au lieu d’être redemandée. (#2635)
- Les notes de preuves PDF précisent leurs limites et diagnostiquent les sources des signets. (#2594)
- La place de marché de compétences résout les conflits de mise à jour par des mises à jour sur place examinées, et les redirections d’actifs de version des spécialistes sont suivies en toute sécurité. (#2615)

## 🐛 Corrections

- **Sessions et plans** — le blocage d’approbation des plans de session survit aux expirations MCP (#2631) ; les liaisons d’artefacts historiques vérifiées sont restaurées (#2633) ; l’annulation d’exécution de tâche se synchronise avec l’admission de session (#2618) ; les environnements d’exécution sont préservés lorsque le démarrage de session est encore en attente (#2620) ; les conversations latérales sont exclues du périmètre d’exportation des paquets (#2619) et les instructions de conversation latérale OpenCode ne fuient plus dans les conversations principales (#2624) ; les vues de littérature reviennent à la conversation du projet d’origine. (#2599)
- **Notebook et calcul** — les exécutions en file d’attente et l’état de l’environnement d’exécution restent cohérents (#2589) ; les nouvelles tentatives de nettoyage conservent la preuve de terminaison native (#2623) ; les répertoires PATH hérités inaccessibles sont tolérés (#2613) ; les chemins Linux déjà masqués ne le sont pas à nouveau.
- **PDF et aperçus** — l’analyse bloquée est récupérée et les échecs d’extraction sont signalés (#2597) ; les mises en page natives des figures et des tableaux sont de nouveau récupérées après une régression (#2617) ; les superpositions d’arrière-plan restent sous les fenêtres modales actives. (#2593)
- **Compétences et connecteurs** — le regroupement par lot des résidus ESM-2 est corrigé (#2601) ; les arguments de région gnomAD sont validés (#2616) et les versions de référence sont appariées aux jeux de données. (#2596)
- **Plateforme** — les installations macOS en lecture seule sont guidées pour corriger les permissions avant la mise à jour (#2603) ; les imports manquants d’identifiants Codex adossés à des fichiers sont expliqués dans Paramètres (#2609) ; le retour d’affectation d’étiquette est de nouveau immédiat (#2610) et le curseur reste en pointeur pendant l’enregistrement.
