## ✨ Points forts

- **Relecture de session.** Rejouez les sessions enregistrées étape par étape et discutez des étapes enregistrées avec votre agent. (#3140)
- **Extension des connecteurs.** Nouveaux connecteurs Cellosaurus et Monarch, et découverte de matrices GEO au sein du connecteur omics. (#3230, #3227, #3238)
- **Extraction de structure des PDF téléversés.** L'extraction de structure fonctionne désormais sur les PDF téléversés, et non plus uniquement sur les PDF générés. (#3222)
- **Menus natifs de la barre de titre Windows.** L'application Windows gagne de véritables menus applicatifs dans la barre de titre. (#3201)

## 🚀 Nouveautés

- Relecture de session : rejouez les sessions enregistrées avec aperçus et interactions de lecture, parcourez l'historique des relectures et discutez des étapes enregistrées avec votre agent. (#3140, #3215, #3218)
- Connecteur Cellosaurus : outils d'identité et de qualité des lignées cellulaires — recherchez des lignées cellulaires, leurs identités et leurs annotations de qualité. (#3230)
- Connecteur Monarch : preuves d'association phénotypique à travers les organismes modèles — associations gène/variant-phénotype avec preuves à l'appui. (#3227)
- Outils de découverte de matrices GEO et de pré-vérification dans le connecteur omics : trouvez des matrices d'expression GEO et pré-vérifiez les téléchargements. (#3238)
- Catalogue de modèles OpenCode Zen étendu avec classification Jev. (#3239)
- Inspection continue du graphique d'utilisation dans les paramètres : zoomez et inspectez l'utilisation dans le temps. (#3236)
- Glissez-déposez des fichiers n'importe où dans la conversation pour les joindre. (#3224)
- Extraction de structure pour les PDF téléversés, en complément de la prise en charge existante des PDF générés. (#3222)
- Menus applicatifs de la barre de titre Windows pour une gestion native des fenêtres. (#3201)
- Les règles d'accès réseau séparent l'automatisation publique des services privés revus : les autorisations privées se lient à un nom d'hôte exact, un port et un ensemble d'adresses revu, avec une nouvelle vérification DNS avant l'enregistrement. (#3249)
- Connecteur PDB : recherche de structures par séquence protéique — retrouvez des structures expérimentales à partir d'une séquence d'acides aminés avec des filtres d'identité, de valeur E et de couverture. (#3250)
- Connecteur IEDB : outils de preuves en immunologie — recherchez des épitopes, des antigènes et des tests cellulaires T, B et MHC avec leurs publications sources. (#3261)

## 🔧 Améliorations

- L'analyse des figures et des tableaux dans les PDF s'exécute désormais avec un travail parallèle borné, accélérant les grands documents. (#3228)
- Dépendances mises à jour pour résoudre des paquets transitifs vulnérables connus. (#3190)
- L'habillage de l'espace de travail et des paramètres est plus compact, incluant les cartes d'outils des messages, le remplissage de la navigation latérale et la carte d'état du réseau. (#3226, #3225, #3214)
- L'indice d'importation de l'espace de travail gagne en contraste pour l'accessibilité. (#3205)

## 🐛 Corrections

- **Relecture et sessions** — l'état du notebook est préservé et les galeries générées stabilisées dans la relecture (#3219) ; les résultats des tours et les échecs d'opérations persistent de façon fiable (#3171) ; les attentes de questions à l'utilisateur survivent aux redémarrages de l'application (#3223).
- **Notebook et runtimes** — le démarrage et le nettoyage du REPL Windows sont renforcés (#3173) ; les autorisations ACL parentes système sont bloquées dans le bac à sable Windows (#3256) ; la confirmation de compatibilité des runtimes Windows et ses diagnostics sont renforcés (#3255) ; le lancement du bac à sable Windows ne se bloque plus sur des reconstructions ACL répétées (#3257) ; les dossiers de distribution WSL choisis dans l'Explorateur sont mappés sans lancer de sous-processus (#3254) ; l'exécution du runtime Windows isolé est réparée (#3105) ; les points d'entrée générés par pip sont reconnus (#3237) ; les chemins d'E/S scientifiques et l'incertitude du chargeur sont conservés (#3216) ; des autorisations d'accès contextuelles aux dossiers sont proposées si nécessaire (#3220) ; la traversée parentale des chemins gérés est accordée sans énumération des répertoires (#3246).
- **PDF et aperçu** — la navigation par plan est alignée sur les positions des sections (#3234) ; les plans indisponibles sont clarifiés et la navigation flotte en mode réduit (#3232) ; la barre latérale des notes flotte dans les lecteurs réduits (#3229) ; le contenu natif des figures et des tableaux est préservé quelle que soit la mise en page des articles (#3217) ; l'extraction de mise en page des publications est renforcée pour les articles complexes (#3247).
- **Agents et autorisations** — les dossiers accordés sont exposés aux sessions Codex (#3209) ; la correspondance des autorisations ACP est unifiée avec diagnostic des approbations de secours (#3189) ; les mises à jour natives des skills OpenCode se corrélationnent correctement (#3198) ; la récupération des autorisations brutes de dossiers est visible dans l'espace de travail (#3235).
- **Espace de travail et paquets** — les objets `.science` identiques sont dédupliqués (#3206) ; les brouillons de fournisseurs et de projets sont protégés et les retours d'actions clarifiés (#3182) ; les erreurs d'arrière-plan peuvent être masquées (#3203) ; les descriptions longues de skills sont tronquées sur une seule ligne, le texte complet apparaissant au survol (#3253).
