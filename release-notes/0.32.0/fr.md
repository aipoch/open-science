## ✨ Points forts

- **Annotations PDF persistantes et notebooks de document.** Les notes et annotations restent désormais attachées à la version du fichier à laquelle elles appartiennent : styles de texte, marques de zone, notes de page et de document, commentaires, couleurs, étiquettes globales, annuler/rétablir et import des annotations PDF natives — avec export vers un PDF annoté distinct ou des notes Markdown/CSV pendant que les octets sources restent intacts. Les pièces jointes de la bibliothèque partagent leur notebook entre références, projets et sessions ; les téléversements de projet et les artefacts le partagent entre les sessions du projet propriétaire. (#2853)
- **Export RO-Crate complet des artefacts.** Une version d’artefact vérifiée peut désormais être empaquetée en une archive RO-Crate 1.1 complète avec ses entrées exactes — les tailles et sommes de contrôle déclarées sont vérifiées avant l’inclusion des octets, les contenus identiques sont dédupliqués et les contenus en conflit sont rejetés. (#2685)
- **Recherche de séquences NCBI BLAST.** De nouveaux outils asynchrones soumettent une requête nucléotidique ou protéique à NCBI BLAST, suivent la tâche jusqu’à son achèvement et récupèrent le rapport dans le format de votre choix — la recherche de similarité pour les séquences inconnues entre dans le connecteur Genomes. (#2829)
- **Découverte élargie des données omiques.** Les exécutions ENA sont découvrables par organisme, stratégie de bibliothèque ou mot-clé, avec les fichiers originaux soumis (BAM, CRAM) à côté des FASTQ d’archive ; les projets PRIDE exposent des listes de fichiers paginées ; les entrées UniProt sont découvrables par nom de gène, expression de protéine et organisme avant le téléchargement des séquences. (#2852, #2844, #2857)

## 🚀 Nouveautés

- L’installation locale des modèles d’analyse de PDF teste des sources miroir vérifiées quand le téléchargement principal est injoignable, en les classant par temps de réponse, si bien que les installations n’échouent plus sur une source unique. (#2837)
- La sélection des capacités peut cibler un service de classification personnalisé compatible TypeSafe — URL du point de terminaison, ID du modèle et clé d’API facultative. Les points de terminaison en boucle locale sans clé sont acceptés ; les points de terminaison distants exigent HTTPS et des identifiants. (#2832)
- Step-5 Preview de StepFun rejoint le catalogue de fournisseurs avec la prise en charge multimodale, une fenêtre de contexte d’un million de jetons et les régions Chine et Global ; les fournisseurs existants conservent leur point de terminaison historique. (#2825)
- Les exécutions de tâches CLI sans surveillance peuvent désormais refuser d’attendre un humain, si bien que l’automatisation ne se bloque plus jamais sur une approbation ou une question qui ne viendra jamais. (#2848)

## 🔧 Améliorations

- Le démarrage et les longues conversations s’allègent : la récupération des preuves est traitée par lots avec réutilisation de l’hydratation des sessions, le travail de présentation Markdown est différé jusqu’à ce qu’il soit nécessaire, les observateurs markdown abandonnent les passes redondantes, les observateurs d’annotations se mettent en pause pendant les diffusions actives, les aperçus des sous-agents ne se chargent qu’une fois affichés et les barres de défilement inactives se masquent. (#2826, #2629, #2831, #2841, #2822, #2823, #2843)
- L’agent classe les demandes de lecture ambiguës de PDF liés au lieu de se rabattre systématiquement sur la requête ciblée, afin que les demandes indirectes portant sur l’ensemble du document soient lues intégralement. (#2828)

## 🐛 Corrections

- **Sessions et environnement d’exécution des agents** — les connexions d’outils OpenCode sont isolées par session, si bien que des sessions sœurs ne peuvent plus invoquer les outils Notebook, artefact ou plan les unes des autres (#2856) ; la propriété de la reprise survit à la publication d’artefacts (#2839) ; les discussions parallèles limitent leurs conversations et leurs avis en file d’attente à l’exécution en cours de l’application (#2827).
- **Calcul et stockage** — la livraison des calculs en arrière-plan est rétablie et l’annulation des travaux est confirmée (#2854) ; les autorisations du système de fichiers sont refusées après un nettoyage incomplet du Notebook (#2851).
- **Connecteurs** — gnomAD ne renvoie plus de jeux de données mitochondriaux inadaptés (#2840).
- **Interface** — la sélection de texte est préservée à travers les calques d’annotation PDF (#2860) ; la recherche rapide des paramètres déplace précisément le focus et l’ancre (#2570) ; les anneaux de focus des tuiles de fichiers restent entièrement visibles après la fermeture de la boîte de dialogue d’aperçu (#2017) ; les alertes de récupération intégrées occupent toute la largeur disponible et placent les actions sous le contenu explicatif (#2850, #2855).
