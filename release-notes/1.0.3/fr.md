## ✨ Highlights

- **Sept nouveaux outils de Connecteurs Scientifiques couvrent l'imagerie, les voies métaboliques, les lipides, les structures et les modèles de cancer.** Les nouveaux outils donnent accès aux collections d'imagerie de The Cancer Imaging Archive (TCIA) et aux requêtes de voies métaboliques KEGG (tous deux sur opt-in), à la régulation moléculaire OmniPath, à la recherche exacte de composés LIPID MAPS, à la validation de structures PDBe avec correspondance croisée UniChem, aux requêtes sur les lignées cellulaires cancéreuses DepMap et CCLE, et à la recherche de similarité de structures PDB — le tout avec une découverte désactivée par défaut et un opt-in persistant par source. (#3760, #3799, #3805, #3808, #3815, #3818, #3828)
- **La bibliothèque Literature devient une véritable boîte de réception de recherche.** La découverte de citations Semantic Scholar met en lumière les références d'un article ainsi que ses articles citants, les pièces jointes supplémentaires multi-sources se téléchargent avec progression et aperçu (y compris les documents Word), les PDF et les fichiers de bibliographie s'importent par glisser-déposer, et les résultats de Smart Screening s'exportent au format CSV prêt pour un tableur. (#3791, #3787, #3776, #3822)
- **Les paquets de session fonctionnent depuis n'importe où.** L'export et l'import `.science` s'exécutent désormais aussi depuis la CLI headless et les sessions Web locales, et plus seulement depuis l'application de bureau. (#3801)
- **Les PDF traduits bénéficient d'une mise en page axée sur le contenu en opt-in, et les notebooks se dotent de restrictions d'accès aux dossiers.** Les éditions traduites peuvent redérouler le texte et les légendes en pages à colonne unique tout en conservant les images, tableaux, formules et bibliographie dans leur forme d'origine, avec des correspondances de pages source vers sortie pour comparaison. Les restrictions d'accès aux dossiers des notebooks, activées par défaut, maintiennent l'exécution des notebooks et des shells dans les dossiers que vous autorisez. (#3637, #3800)

## 🚀 New Features

- Outils de connecteur TCIA (collections d'imagerie du cancer) et KEGG (voies métaboliques et médicaments) en opt-in. (#3799)
- Requêtes OmniPath couvrant la régulation moléculaire et les interactions de signalisation. (#3805)
- Recherche exacte de composés LIPID MAPS par identifiant ou par nom. (#3808)
- Validation de structures PDBe avec correspondance UniChem vers les bases de données chimiques connectées. (#3815)
- Requêtes sur les modèles de cancer DepMap et CCLE pour les données de dépendance des lignées cellulaires. (#3818)
- Recherche de similarité de structures PDB à partir d'un identifiant de structure. (#3828)
- Découverte de citations Semantic Scholar dans Literature, avec une clé API facultative pour des limites de débit plus élevées. (#3791)
- Pièces jointes supplémentaires multi-sources avec progression de téléchargement par fichier, extraction d'archives pour les fichiers sélectionnés et aperçus par type de fichier, y compris les documents Word. (#3787)
- Import par glisser-déposer de PDF et de fichiers de bibliographie dans la bibliothèque Literature, ainsi que téléchargement des pièces jointes depuis la vue de détail de la référence. (#3776)
- Export des résultats de Smart Screening au format CSV, couvrant tous les candidats avec verdicts finaux, décisions manuelles, raisons et probabilités du modèle. (#3822)
- Export et import de paquets de session `.science` depuis la CLI headless et les sessions Web locales. (#3801)
- Option de mise en page axée sur le contenu pour les PDF traduits, désactivée par défaut et mémorisée par édition de traduction. (#3637)
- Restrictions d'accès aux dossiers des notebooks, activées par défaut pour les nouvelles installations, confinant l'exécution des notebooks et des shells aux dossiers autorisés. (#3800)
- L'outillage des fichiers locaux peut lister les répertoires autorisés à la demande, afin que les agents réutilisent les autorisations de dossier existantes au lieu de redemander. (#3767)
- Les modèles du fournisseur Kimi K3.1 Pro sont disponibles pour la sélection. (#3835)

## 🔧 Improvements

- Les transferts de paquets de session déplacent davantage de données par défaut, et l'import saute les passes de vérification répétées, afin que les archives volumineuses se terminent plus vite. (#3782, #3780)
- L'annotation des PDF et l'analyse de structure sont plus rapides sur les documents volumineux. (#3825, #3831)
- Les changements de Specialist affichent une progression pendant le chargement du nouveau specialist. (#3778)
- Les éditeurs de paramètres verrouillent leurs champs pendant l'enregistrement et protègent les brouillons non enregistrés sur les écrans Memory, Tags et identifiants. (#3781, #3849)

## 🐛 Bug Fixes

- Windows : l'enregistrement du protocole `open-science` est restauré, l'hôte notebook est reconstruit avant le démarrage dans les configurations de développement, et les paquets de session re-hachent correctement le contenu sous Windows. (#3777, #3843, #3829)
- La récupération de session survit désormais aux défaillances de modèle, et les fichiers de conversation endommagés peuvent être supprimés au lieu de bloquer la récupération. (#3740, #3804)
- Le changement de Specialist se rétablit de certains refus de fournisseur sans perdre la conversation, et les échecs de capacité sont distingués des liaisons indisponibles. (#3772, #3796)
- Le compositeur bascule correctement entre l'arrêt et l'envoi en file d'attente. (#3768)
- Paquets de session : le code de recherche ne déclenche plus de faux positifs d'identifiants, et l'export reprend correctement après un accusé de réception de contenu sensible. (#3817, #3846)
- Bac à sable réseau des notebooks : les approbations persistent à travers les redémarrages, les règles avec caractères génériques et la saisie d'URL sont acceptées, le routage via proxy natif est activé, et les limites du système de fichiers et du proxy restent appliquées. (#3830, #3826, #3827, #3841)
- L'analyse des notebooks préserve la filiation à travers les effets scientifiques enchaînés, les codes de sortie signés des shells survivent, les sondes de protection ne ralentissent plus le démarrage des sessions, et les recherches shell restent à l'intérieur du bac à sable du système de fichiers. (#3812, #3851, #3839, #3788)
- La gestion des PDF exclut le texte rogné et les références de figures renvoyées de l'analyse de structure, renforce la propriété des figures, tableaux et du mode Lecteur, et simplifie les aperçus d'une seule page. (#3795, #3814, #3816)
- La récupération sur le bureau résout les défauts de titre reproduit, de nouvelle tentative et de protection. (#3823)
- Les arguments de la sonde d'abonnement Claude sont préservés dans les paramètres. (#3837)
- Les services sans rapport sont exclus du nettoyage des processus au runtime. (#3797)
- Les imports du navigateur préservent les nouvelles tentatives à travers la suspension. (#3770)
