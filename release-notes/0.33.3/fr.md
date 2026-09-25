## ✨ Points forts

- **Revue de documents paginée.** L’aperçu gagne une lecture Office paginée avec des contrôles de recherche (#3024) et une revue PowerPoint page par page, si bien que les longs documents et présentations se lisent confortablement dans l’application. (#2991)
- **Enrichissement de gènes Enrichr.** Le connecteur de gènes ajoute des outils Enrichr : parcourez les bibliothèques d’enrichissement et évaluez votre liste de gènes par rapport à celles-ci. (#2996)
- **Aperçu compact de la bibliothèque.** La barre latérale de l’espace de travail gagne un aperçu compact de la bibliothèque pour des consultations rapides sans quitter votre flux. (#3030)
- **Signature Windows, achevée.** La signature de code couvre désormais tous les exécutables fournis, y compris les lanceurs du runtime du notebook. (#3001, #3011)

## 🚀 Nouveautés

- Lecture paginée des documents Office avec contrôles de recherche dans le panneau d’aperçu. (#3024)
- Revue PowerPoint page par page : parcourez les diapositives une à une avec des contrôles de lecture. (#2991)
- Aperçu compact de la bibliothèque dans l’espace de travail pour une consultation en un coup d’œil. (#3030)
- Enrichissement de gènes Enrichr dans le connecteur de gènes : listez les bibliothèques disponibles et enrichissez une liste de gènes soumise. (#2996)
- Les collections intelligentes de Literature gagnent une action d’abandon d’évaluation pour les références qui ne nécessitent plus de criblage. (#2973)
- Les paquets de session gagnent des options de vitesse de transfert adaptative pour les exportations et les importations. (#2997)
- La progression des exportations en arrière-plan est minimisée pour que les longs transferts restent discrets. (#3005)
- Les raccourcis d’échelle de l’interface sont unifiés en un schéma cohérent. (#3018)
- Les infobulles au survol et le mouvement des bulles sont unifiés dans toute l’interface. (#3010)
- Les nouveaux messages apparaissent avec une animation dans le centre de messages. (#3025)
- La navigation dans les messages gagne une vague de survol dense et continue pour un balayage plus fluide. (#3004)

## 🔧 Améliorations

- La signature de code Windows couvre désormais tous les exécutables fournis, y compris les lanceurs du runtime du notebook signés, vérifiés au démarrage. (#3001, #3011)

## 🐛 Corrections

- **Aperçu et interface** — la taille de police de l’onglet de lecture PDF correspond à celle de l’en-tête du fichier (#3036) ; des infobulles apparaissent sur les icônes de la barre latérale réduite (#3017) ; les zones cliquables des lignes s’alignent avec leurs surfaces de survol (#3013) ; le mouvement d’entrée des bulles est ignoré lors des changements de survol à chaud (#3032).
- **Notebook** — les barrières de récupération des noyaux sont isolées par voie, si bien que la récupération d’un noyau ne bloque jamais un autre (#3031).
- **Sessions et récupération** — les sauvegardes de conversation sont différées pendant l’exécution des tâches (#3012) ; les nouvelles tentatives échouées restent récupérables et fermables (#3019) ; les notifications d’erreur d’exécution peuvent être fermées (#3002) ; la barrière de récupération des archives est limitée aux projets concernés (#3023) ; les exports de diagnostics renommés reçoivent un suffixe d’archive (#3022).
- **Connecteurs et literature** — l’accès natif aux fichiers honore les dossiers autorisés (#3021) ; les résumés Crossref sont importés lors de la complétion des métadonnées (#3020) ; la classification sélectionne le premier modèle pour les deux fonctionnalités (#3006).
