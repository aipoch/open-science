## ✨ Points forts

- **Exécution des notebooks avec révision.** Chaque exécution de notebook est analysée à la recherche de code destructeur ou risqué avant de s'exécuter ; les exécutions risquées affichent une carte de révision ciblée avec le contexte des lignes source et un reçu durable, tandis que les analyses courantes s'exécutent sans sollicitations répétées. (#3336)
- **Traduction PDF partagée et reprise possible.** Traduisez un PDF complet avec des points de contrôle au niveau du paragraphe, basculez entre les modes de lecture original, traduction et comparaison côte à côte, et reprenez la traduction d'une session à l'autre — une édition enregistrée par PDF géré, partagée entre toutes les entrées. (#3334)
- **Extension des connecteurs.** Un nouveau connecteur PDC apporte la découverte d'études de protéomique du cancer, d'échantillons biologiques et de fichiers, et le connecteur Genomes gagne les requêtes de déséquilibre de liaison spécifiques à une population. (#3335, #3337)
- **Claude Haiku 5.5.** Le catalogue Anthropic fourni ajoute Claude Haiku 5.5 avec sa fenêtre de contexte de 1 million de jetons. (#3333)

## 🚀 Nouveautés

- Exécution des notebooks avec révision : analyse de risque par exécution et reçus de révision durables (#3336)
- Traduction PDF de document complet avec reprise possible et modes de lecture original/traduction/comparaison (#3334)
- Connecteur PDC : recherche d'études de protéomique du cancer, d'associations d'échantillons biologiques et de métadonnées quantitatives de fichiers (#3335)
- Requêtes de déséquilibre de liaison Ensembl spécifiques à une population : r²/D′ par paires et recherche de variants de substitution (#3337)
- Claude Haiku 5.5 dans le catalogue de modèles Anthropic (#3333)
- Sélection de toute la page chargée dans les barres d'outils de lot de la Bibliothèque documentaire et de la Boîte de réception (#3340)
- Glissez une carte de fichier de projet ou l'artefact ouvert dans le compositeur pour le mentionner (#3315)

## 🔧 Améliorations

- La filiation des dépendances scientifiques est renforcée pour les notebooks Python et R : davantage de lecteurs scientifiques, de transformations de conteneurs et de rappels sont suivis, afin que les arêtes de dépendance et les effets sur les fichiers restent exacts (#3309, #3332)

## 🐛 Corrections

- L'extraction de la structure des PDF préserve les mises en page scientifiques natives — tableaux complets, en-têtes à plusieurs niveaux, pieds de page et figures multi-panneaux (#3320)
- Le panneau Fichiers ne bloque plus les mentions de fichiers dans une nouvelle conversation (#3338)
- Rechercher (Ctrl/Cmd+F) fonctionne à nouveau dans un espace de travail vide (#3316)
- La place de marché des spécialistes s'ouvre dans le Web à distance (#3331)
- Les puces de mention compactes des compositeurs de nouvelle session s'affichent à nouveau à leur taille normale (#3341)
- Les alias de suffixe de taille de contexte sont retirés des catalogues de modèles officiels, corrigeant les échecs de sélection de modèle avec certains moteurs (#3326)
