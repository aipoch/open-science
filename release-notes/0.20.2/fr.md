## ✨ Points forts

- **Interface en espagnol.** L'interface complète — accueil guidé, réglages, surfaces de conversation, boîtes de dialogue natives et notes de version — est désormais disponible en espagnol, rejoignant les sept langues existantes avec un sélecteur de langue à chaud dans les réglages. (#1771)
- **Aperçus de sources intégrés.** Les liens des réponses de l'agent s'ouvrent dans un aperçu sandboxé dans l'application : le survol révèle le titre de la source et l'URL complète, et un clic charge la page dans le panneau latéral avec un indicateur de progression déterministe, sans quitter votre espace de travail. (#1524)
- **Variables de notebook en direct.** Une nouvelle vue Variables inspecte l'espace de noms Python ou R en cours d'exécution — noms, types, formes et aperçus — en lecture seule, actualisée après chaque exécution, sans démarrer un noyau juste pour parcourir. (#1748)
- **Aperçus de session au survol.** Survoler ou focaliser une session dans la barre latérale affiche son titre et sa description, et les titres trop longs défilent pour rester distinguables. (#1775)

## 🚀 Nouveautés

- **Localisation en espagnol** — catalogues complets (commun, natif et rendu) dans un espagnol international neutre, messages Electron natifs, formatage des dates et documentation localisée. (#1771, #1780)
- **Aperçus de sources intégrés** — les liens HTTPS des réponses de l'agent deviennent des liens de source natifs avec une popover interactive, un chargement sandboxé dans le panneau avec indicateur de progression dans la barre d'outils, un raccourci vers le navigateur externe, la navigation clavier et l'affichage conservé de l'URL complète. (#1524)
- **Navigateur d'espace de noms en direct** — une vue Variables de second niveau pour les noyaux de notebook, avec filtrage, bascule des noms privés, actualisation manuelle et états périmé/actualisation/indisponible ; les instantanés sont bornés et jamais persistés. (#1748)
- **Aperçus de session au survol** — aperçu immédiat du titre et de la description au survol ou au focus clavier, prise en charge des préférences de mouvement réduit, réservée au bureau. (#1775, #1796, #1797)
- **Menu contextuel des onglets d'aperçu** — Fermer, Fermer les autres, plus Télécharger, Copier le chemin et Enregistrer en artefact selon le contexte, ancré au pointeur sans activer l'onglet. (#1764)
- **Cartes de clarification avec revue par question** — les cartes de questions répondues ou ignorées deviennent des enregistrements compacts dont les réponses se déploient pour retrouver les questions d'origine, avec des compteurs de sélection exacts et des commandes plus compactes. (#1772)
- **Nouveaux fournisseurs et modèles** — OpenCode Go et OpenCode Zen comme fournisseurs intégrés à clé API, et GLM-5.3-Flash en complément de GLM-4.5-Air et GLM-5.3 pour Zhipu AI (GLM). (#1763, #1790, #1762, #1766)

## 🔧 Améliorations

- Le rendu des conversations ne charge les runtimes Mermaid et de coloration syntaxique que lorsqu'un message les contient réellement, raccourcissant le démarrage du rendu. (#1789)
- Les sessions de longue durée persistent à une cadence bornée au lieu d'une écriture par trame d'affichage, éliminant une pression CPU, mémoire et disque soutenue sur les grandes sessions. (#1779)
- Le pied de réponse libelle son résumé de requêtes modèle en appels, cohérent avec la vue de fenêtre de contexte. (#1781)
- L'archivage d'un projet attend désormais les revues actives et les tâches de calcul distant non terminées, et suspend le pipeline de messages en attente jusqu'à la restauration du projet. (#1785)
- Les longs résumés de plan sont bornés à trois lignes avec révélation au survol, et l'aperçu du plan conserve sa position de défilement entre les mises à jour de progression en flux. (#1783)

## 🐛 Corrections

- **Sessions** — les approbations d'autorisation n'entrent plus en collision avec la génération du titre/description ; les deux sont conservés au lieu d'afficher une alerte de persistance. (#1768)
- **Sessions** — les sessions interrompues reprennent en préservant l'échec faisant autorité lorsque les fournisseurs rapportent des erreurs structurées, au lieu de réinitialiser silencieusement le contexte. (#1774)
- **Projets** — un contexte d'agent de projet configuré est appliqué de manière cohérente : les échecs de recherche ferment de manière sûre et les modifications de contexte s'appliquent aux sessions inactives avant la prochaine invite. (#1786)
- **Fichiers de projet** — les échecs de modification des autorisations de dossier accordé affichent désormais une explication réessayable au lieu de conserver silencieusement l'ancienne autorisation. (#1793)
- **Notebook** — les requêtes RPC locales sont strictement validées par méthode, rejetant les paramètres mal formés avant l'exécution. (#1794)
- **Aperçus de session** — les aperçus au survol se ferment immédiatement et continuent de fonctionner après les changements du pont de pointeur. (#1796, #1797)
