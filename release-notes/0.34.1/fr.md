## ✨ Points forts

- **Nouvelle paire de connecteurs.** Un connecteur CELLxGENE Discover découvre des jeux de données publics de cellules uniques, et un connecteur Alliance of Genome Resources couvre les gènes d'organismes modèles inter-espèces. (#3178, #3136)
- **Extension des variants et de l'omique.** Les scores fonctionnels MaveDB rejoignent le connecteur de variants, et le connecteur d'omique étend sa couverture de Metabolomics Workbench. (#3131, #3139)
- **Boîte de réception dans l'aperçu de la bibliothèque.** L'aperçu de la bibliothèque de l'espace de travail gagne un onglet Boîte de réception pour la file d'attente, avec acceptation, rejet, annulation et acceptation par lots. (#3174)
- **gpt-6.1-sol.** Le sélecteur de modèle ajoute gpt-6.1-sol sans modifier les valeurs par défaut existantes. (#3157)

## 🚀 Nouveautés

- Connecteur CELLxGENE Discover : recherchez des jeux de données et collections publics de cellules uniques, filtrez par organisme, tissu, maladie, dosage ou type cellulaire, inspectez les versions publiées et obtenez les formats de fichiers, tailles et URL de téléchargement, ainsi que les descriptions de types cellulaires CellGuide et les gènes marqueurs. (#3178)
- Connecteur Alliance of Genome Resources : recherchez et résumez des gènes chez l'humain, la souris, le rat, la mouche, le ver, le zèbre, la levure et la grenouille — orthologues, modèles de maladies, annotations phénotypiques, allèles, expression et associations avec les termes de maladies. (#3136)
- Scores fonctionnels MaveDB dans le connecteur de variants : recherche de jeux de scores et métadonnées, scores fonctionnels spécifiques au dosage, correspondances de variants VRS et expériences. (#3131)
- Couverture étendue de Metabolomics Workbench dans le connecteur d'omique : fiches d'études, échantillons, facteurs expérimentaux, métadonnées d'analyse et structures et références croisées de composés. (#3139)
- gpt-6.1-sol comme option de modèle, avec des valeurs par défaut inchangées. (#3157)
- Onglet Boîte de réception dans l'aperçu de la bibliothèque de l'espace de travail : parcourez la file d'attente avec recherche et pagination, acceptez ou rejetez des éléments individuels avec annulation, et acceptez des lots par sélection explicite de page. (#3174)
- Une entrée d'importation `.science` dans l'état vide de l'espace de travail pour importer des paquets de recherche. (#3170)
- Les paquets de session peuvent exporter du contenu sensible confirmé avec confirmation explicite. (#3164)
- Les exports de diagnostics locaux préservent les preuves de dépannage pour le support. (#3143)
- Raccourcis d'envoi de retour dans les plans de session. (#3125)
- Statut de l'hôte affiché dans le menu de calcul du compositeur. (#3124)

## 🔧 Améliorations

- Les aperçus d'exécution pointent directement vers les messages pertinents. (#3120)
- Les brouillons de compétences sont protégés et les interactions de compétences sont clarifiées. (#3142)
- Les indications de correspondance de journaux sont simplifiées et les rôles des colonnes d'importation de journaux sont clarifiés. (#3172, #3169)

## 🐛 Corrections

- **Notebook et runtimes** — l'état de l'interpréteur est préservé d'une cellule à l'autre (#3129) ; les outils globaux npm du bac à sable sont partagés entre les sessions (#3160) ; les échecs de liaison de la passerelle loopback sont expliqués en langage clair (#3138) ; la capture de lignage scientifique Python et R est renforcée (#3163).
- **PDF et aperçu** — le contenu natif des figures et des tableaux est préservé lors de l'extraction de la structure (#3162) ; les workers d'aperçu PDF s'exécutent dans les clients de navigateur (#3135) ; les URL de référence apparaissent dans la vue de détail (#3151) ; la sélection d'annotation est effacée avant la fermeture du lecteur (#3156) ; le style d'aperçu des tableaux fusionnés et l'ombre de débordement de la colonne épinglée sont corrigés (#3165, #3167).
- **Sessions et paquets** — les autorisations de suivi survivent aux redémarrages de l'agent (#3147) ; les métadonnées booléennes sont préservées lors de l'export de paquets (#3133).
- **Journaux** — les filtres de journaux sont validés et les colonnes d'alias sont reconnues (#3145) ; les lectures d'entrées de journaux invalidées sont réessayées (#3148).
- **Plateforme** — Windows permet la réinstallation après la suppression d'une ancienne installation parente (#3176) ; le démarrage de KWallet sous Linux est restauré (#3168) ; l'identité d'identifiants accepte les journaux SQLite complétés (#3126).
