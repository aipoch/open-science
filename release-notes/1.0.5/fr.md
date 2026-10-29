## ✨ Highlights

- **Les connecteurs scientifiques atteignent les API sources natives.** Europe PMC gagne une recherche directe booléenne, de base et par résumé avec une pagination explicite, aux côtés de nouvelles métadonnées de gènes HGNC, de rangs d'enrichissement ChEA3, de conversions bioDBnet et d'orthologie, de requêtes de graphe de connaissances RDF Cellosaurus, de similarité STR et d'une découverte de fichiers officiels pour NHANES, PhysioNet, openFDA et CTD — le tout sur option et renvoyant des URL officielles avec provenance plutôt que des téléchargements opaques. Les requêtes et identifiants que vous soumettez — termes de recherche, noms de gènes, DOI — sont envoyés aux services publics respectifs, et les sources à accès réglementé sont listées avec leurs instructions d'accès officielles uniquement ; l'application ne revendique jamais votre autorisation. (#3869)
- **Suivez l'avancement de lecture dans la bibliothèque Literature.** Les références peuvent être marquées Non lues, En cours de lecture ou Terminées ; le statut s'affiche dans une colonne dédiée, se modifie en ligne ou depuis la page de détails, se met à jour en masse sur plusieurs pages et exclusions, et filtre la bibliothèque avec des comptes cohérents et une portée de sélection. (#3897, #3907)
- **Les paquets de session fonctionnent dans le navigateur.** Les déploiements Web locaux peuvent exporter un paquet `.science` en téléchargement et en importer un via un sélecteur d'envoi — sans repli vers la CLI lorsqu'on travaille entièrement dans le navigateur. Un paquet exporté contient les conversations, les fichiers, les enregistrements de notebooks et la provenance que vous avez sélectionnés, et les transferts dans le navigateur s'effectuent entre votre navigateur et votre propre service local. (#3911)
- **La durée de vie du service suit votre intention.** Garder l'application ouverte ou exécuter `open-science start` maintient le service local actif ; fermer une fenêtre ne l'arrête plus ni ne coupe les tâches d'arrière-plan sans rapport. Un simple `stop` libère votre maintien et `stop --force` demande l'arrêt complet du service. Tant qu'un maintien est actif, le service et ses tâches d'arrière-plan continuent de s'exécuter jusqu'à ce que vous relâchiez le maintien ou que vous forciez l'arrêt. (#3769)

## 🚀 New Features

- La page d'accueil gagne une galerie de cas d'usage : parcourez des exemples publiés, ouvrez leur détail et importez un paquet de session vérifié avec suivi de la progression du téléchargement et annulation. (#3901)
- Points d'entrée de mise à jour manuels : liens de téléchargement et d'instructions persistants dans les paramètres et les surfaces de mise à jour, plus une commande en lecture seule qui révèle l'installateur confirmé. (#3902)
- Paramètres → À propos renvoie à la politique de sécurité du projet. (#3906)
- Les répertoires autorisés s'affichent sous forme de liste compacte de dossiers avec badges de lecture/écriture et infobulles au moment de l'accord, au lieu de JSON brut. (#3871)

## 🔧 Improvements

- Les rapports DOCX préservent les styles de tableau, bordures et mise en page souhaités pendant la génération et l'aperçu, et un workflow de conversion Markdown-vers-DOCX maintenu et basé sur des modèles est disponible à la demande. (#3811)
- Les résultats de la vérification de publication présentent une action courte avec attribution Crossref et heure de dernière vérification. (#3896)
- Le détail d'une référence regroupe les étiquettes et le type dans l'en-tête, avec les explications répétitives supprimées. (#3910)
- Les surfaces de paquet de session importé et de replay suppriment les diagnostics redondants et donnent à leurs actions des limites cohérentes et visibles. (#3908)
- Les requêtes R gérées sous Windows pour des packages Bioconductor expliquent désormais la voie explicite via BiocManager au lieu d'échouer avec une erreur Conda générique. (#3918)

## 🐛 Bug Fixes

- Les sessions à accès complet admettent les destinations réseau publiques sans invites d'approbation, et rétrograder Complet ferme les connexions existantes. (#3898)
- Paramètres → Réseau reflète immédiatement les autorisations de domaine globales accordées depuis les boîtes de dialogue d'approbation. (#3900)
- Les runtimes OpenCode 2.x démarrent de nouveau et fonctionnent, avec le chemin 1.x conservé. (#3903)
- Les notebooks macOS trouvent les outils CLI dont le runtime Node vit en dehors du PATH hérité de l'application. (#3916)
- Les discussions sous Windows n'attendent plus la configuration de protection avant le démarrage d'une requête de fournisseur. (#3922)
- Les notebooks lisent les fichiers de référence de skill gérés par l'application sans invite d'accès au dossier. (#3920)
- Le repli des groupes d'outils préserve votre position de lecture. (#3873)
- Les tableaux Markdown larges révèlent leur barre de défilement au survol et au focus clavier. (#3875)
