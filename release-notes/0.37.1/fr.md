## ✨ Points forts

- **Fidélité PDF restaurée.** L'extraction de structure conserve les figures complètes avec leurs légendes, reconstruit les tableaux à filets qui côtoient des formules sans les rejeter, et préserve l'attribution native des régions de figures, des enregistrements de tableaux et du texte d'origine. (#3456, #3465)
- **Une expérience Windows plus silencieuse et robuste.** Le CLI de bureau fonctionne depuis des chemins d'installation non-ASCII, la traduction PDF gère les chemins de lecteurs Windows, et les noyaux Notebook et les captures d'environnement n'ouvrent plus de fenêtre console. (#3457, #3460)

## 🔧 Améliorations

- Les installateurs de bureau et le runtime autonome se débarrassent des charges inutilisées — dépendances groupées en double, ressources de runtime de modèle et de tokeniseur inutilisées, et bibliothèques plateforme que l'application ne charge jamais — inversant la croissance de taille introduite par la scission du backend en v0.37.0 (#3451, #3470)

## 🐛 Corrections

- Une référence de panneau espacée dans le texte en cours ne divise plus une figure en recadrages rastérisé et vectoriel séparés, et le remplissage du détecteur sous la règle de clôture d'un tableau ne provoque plus le rejet de tout le tableau comme une formule endommagée (#3465)
- L'extraction PDF native conserve la propriété des légendes et des graphiques au bon élément, récupère les enregistrements de tableaux à bornes indépendantes avec en-têtes groupés et groupes de lignes, et conserve les références source des cellules et le texte enrichi (#3456)
- Le CLI de bureau ne lit plus de manière erronée son lanceur sous les pages de codes héritées lorsque le chemin d'installation contient des caractères chinois, et préserve la page de codes et le code de sortie de l'appelant (#3457)
- La traduction PDF locale sous Windows n'échoue plus avec une URL de module non prise en charge lorsque les ressources WASM résident sur un chemin de lecteur (#3457)
- Les noyaux Notebook, l'empreinte d'environnement, l'inventaire des packages et la capture des verrous ne font plus apparaître une fenêtre console ou Windows Terminal pendant l'exécution (#3460)
- La régénération d'un PDF traduit ne rejette plus le texte source légitime en raison de différentes orthographes de noms de glyphes intégrés — les glyphes vérifiés conservent leur encre d'origine (#3469)
