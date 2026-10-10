## ✨ Points forts

- **Un backend Node autonome.** Les services partagés derrière le bureau, le web, la CLI et le Notebook s'exécutent désormais dans un processus Node ordinaire — la ligne de commande et le mode headless n'ont plus besoin d'un hôte Electron sans fenêtre, l'application de bureau se connecte comme un client natif, et les backends du bureau choisissent automatiquement un port libre. (#3358, #3393)
- **Extension des connecteurs.** Un nouveau connecteur ENCORI intégré apporte des preuves d'interactions miRNA–cible et ARN–ARN, ChEMBL ajoute les détails d'essais et la pagination des bioactivités, et ClinVar ajoute les preuves de soumissions individuelles. (#3376, #3343, #3361)
- **Fidélité pour les PDF scientifiques.** La traduction PDF préserve l'ordre de lecture natif, les étiquettes ActualText imbriquées se vérifient correctement, et l'extraction de structure conserve les figures appartenant à la source et les enregistrements de tableaux complets. (#3360, #3348, #3370)
- **Approbations et capture du Notebook apaisées.** Les runtimes par défaut prêts ne déclenchent plus de double invite, les environnements mixtes rapportent avec précision, et les métadonnées de construction des packages restent visibles. (#3380, #3398, #3385)

## 🚀 Nouveautés

- Backend Node autonome pour les services partagés — `open-science start` s'exécute sans Electron, et l'application de bureau se connecte comme un client natif (#3358)
- Connecteur ENCORI avec dix outils pour les cibles miRNA, les interactions ARN–ARN, les preuves régulatrices, les tables de référence et les jeux de données en vrac (#3376)
- Le connecteur ChEMBL gagne les détails d'essais et la pagination des bioactivités au-delà des 1 000 premiers enregistrements (#3343)
- Le connecteur ClinVar gagne les preuves de soumissions individuelles pour comparer les classifications des soumetteurs (#3361)
- État vide de l'accueil avec des conseils et une action Créer un projet (#3371)

## 🔧 Améliorations

- Environnements du Notebook : capture précise des environnements mixtes Conda/pip, métadonnées de construction micromamba préservées dans le tableau des packages, et dépendances de rappels et filiation des entrées de fichiers renforcées (#3398, #3385, #3369)
- Sur Linux, les identifiants cessent de sonder le backend Secret Service après la première opération de secret, évitant les sorties de récupération fatales intempestives (#3389)
- L'approbation et le rejet du plan de session n'interfèrent plus avec la récupération de l'exécution (#3366)
- Les publications GitHub incluent désormais des archives CLI autonomes (macOS et Linux arm64/x64, Windows x64) aux côtés des installateurs de bureau ; l'installation de la CLI ne requiert plus de chaîne d'outils Node.js locale (#3394)

## 🐛 Corrections

- Les backends du bureau attribuent un port libre, corrigeant les échecs de démarrage lorsqu'un autre backend est déjà en cours d'exécution (#3393)
- La détection de Python sous Windows n'interprète plus de manière erronée les chemins d'interpréteurs contenant des espaces ou des parenthèses (#3362)
- Le runtime de bureau préserve le profil de backend sélectionné sous Windows (#3395)
- L'import d'un package `.science` dans un nouveau projet n'échoue plus lors de l'adoption du catalogue (#3379)
- Les collections intelligentes reprennent et réessaient le lot en échec au lieu de recommencer depuis le début (#3351)
- Codex récupère les arguments d'outils MCP diffusés en continu qui arrivent vides dans l'appel terminé (#3349)
- Le changement de spécialiste sous Windows ne laisse plus un passage de relais approuvé en attente et bloquant les invites ultérieures (#3388)
- Le connecteur PDB rejette les réponses de recherche mal formées au lieu de les rapporter comme zéro résultat, et la pagination incomplète n'est plus marquée comme terminée (#3399)
- Le mode automatique cesse de demander des approbations d'outils redondantes pour inspecter ou annuler une exécution en arrière-plan, énumérer les environnements, examiner un plan ou prévisualiser l'importation d'une compétence (#3408)
- Les cellules Notebook qui échouent avant toute exécution du code source ne persistent plus dans l'historique des risques du même noyau et n'imposent plus d'approbations répétées sur les cellules suivantes (#3410)
- Les hôtes sans interface et les consommateurs du SDK résolvent à nouveau les ressources groupées du runtime Notebook (boucles d'exécution, capture de preuves et grammaires d'analyse de code source) (#3406)
