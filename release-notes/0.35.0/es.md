## ✨ Lo más destacado

- **Reproducción de sesiones.** Reproduce las sesiones grabadas paso a paso y comenta los pasos grabados con tu agente. (#3140)
- **Expansión de conectores.** Llegan los nuevos conectores de Cellosaurus y Monarch, y el descubrimiento de matrices GEO se une al conector de ómica. (#3230, #3227, #3238)
- **Extracción de estructura en PDF cargados.** La extracción de estructura ahora funciona en PDF cargados, no solo en los generados. (#3222)
- **Menús nativos de la barra de título en Windows.** La app de Windows gana menús de aplicación adecuados en la barra de título. (#3201)

## 🚀 Novedades

- Reproducción de sesiones: reproduce las sesiones grabadas con vistas previas e interacciones de reproducción, explora el historial de reproducciones y comenta los pasos grabados con tu agente. (#3140, #3215, #3218)
- Conector de Cellosaurus: herramientas de identidad y calidad de líneas celulares — busca líneas celulares, sus identidades y anotaciones de calidad. (#3230)
- Conector de Monarch: evidencia de asociación de fenotipos en organismos modelo — asociaciones de gen/variante a fenotipo con evidencia de apoyo. (#3227)
- Descubrimiento de matrices GEO y herramientas de comprobación previa en el conector de ómica: encuentra matrices de expresión de GEO y comprueba las descargas antes de iniciarlas. (#3238)
- Catálogo de modelos de OpenCode Zen ampliado con clasificación Jev. (#3239)
- Inspección continua del gráfico de uso en ajustes: amplía e inspecciona el uso a lo largo del tiempo. (#3236)
- Arrastra y suelta archivos en cualquier parte de la conversación para adjuntarlos. (#3224)
- Extracción de estructura para PDF cargados, junto a la compatibilidad existente con PDF generados. (#3222)
- Menús de aplicación en la barra de título de Windows para una gestión nativa de ventanas. (#3201)
- Las reglas de acceso a la red separan la automatización pública de los servicios privados revisados: las concesiones privadas se vinculan a un nombre de host exacto, un puerto y un conjunto de direcciones revisado, con DNS reverificado antes de guardar. (#3249)
- El conector de estructuras PDB gana búsqueda de secuencias de proteínas: encuentra estructuras experimentales por secuencia de aminoácidos con filtros de identidad, E-value y cobertura. (#3250)
- Conector IEDB: herramientas de evidencia en inmunología — búsqueda de epítopos, antígenos y ensayos de células T, células B y MHC con sus publicaciones de origen. (#3261)

## 🔧 Mejoras

- El análisis de figuras y tablas en PDF ahora ejecuta trabajo en paralelo con límites, acelerando los documentos grandes. (#3228)
- Dependencias actualizadas para resolver paquetes transitivos con vulnerabilidades conocidas. (#3190)
- El cromo del espacio de trabajo y de ajustes es más compacto, incluidas las tarjetas de herramientas de mensajes, el relleno de navegación de la barra lateral y la tarjeta de estado de red. (#3226, #3225, #3214)
- La sugerencia de importación del espacio de trabajo gana contraste para accesibilidad. (#3205)

## 🐛 Correcciones

- **Reproducción y sesiones** — el estado del notebook se conserva y las galerías generadas se estabilizan en la reproducción (#3219); los resultados de los turnos y los fallos de operaciones persisten de forma fiable (#3171); las esperas de preguntas al usuario sobreviven a los reinicios de la app (#3223).
- **Notebook y tiempos de ejecución** — el inicio y la limpieza del REPL en Windows se endurecen (#3173); las concesiones ACL de sistemas padre se bloquean en el sandbox de Windows (#3256); la confirmación de compatibilidad de tiempos de ejecución en Windows y sus diagnósticos se endurecen (#3255); el lanzamiento del sandbox de Windows ya no se estanca en reconstrucciones ACL repetidas (#3257); las carpetas de distribuciones WSL elegidas desde Explorer se mapean sin generar subprocesos (#3254); la ejecución aislada del tiempo de ejecución en Windows se repara (#3105); los puntos de entrada generados por pip se reconocen (#3237); las rutas de E/S científicas y la incertidumbre del cargador se conservan (#3216); los permisos contextuales de acceso a carpetas se ofrecen cuando se necesitan (#3220); el recorrido a directorios padre para rutas gestionadas se concede sin enumeración de directorios (#3246).
- **PDF y vista previa** — la navegación por esquema se alinea con las posiciones de las secciones (#3234); los esquemas no disponibles se aclaran y la navegación estrecha flota (#3232); la barra lateral de notas flota en lectores estrechos (#3229); el contenido nativo de figuras y tablas se conserva en distintas maquetas de artículos (#3217); la extracción de maquetación de literatura se endurece para artículos complejos (#3247).
- **Agentes y permisos** — las carpetas concedidas se exponen a las sesiones de Codex (#3209); la coincidencia de concesiones de ACP se unifica con diagnóstico de aprobaciones de respaldo (#3189); las actualizaciones de skills nativas de OpenCode se correlacionan correctamente (#3198); la recuperación de permisos de carpetas sin procesar se muestra en el espacio de trabajo (#3235).
- **Espacio de trabajo y paquetes** — los objetos `.science` idénticos se deduplican (#3206); los borradores de proveedor y Project se protegen y la retroalimentación de acciones se aclara (#3182); los errores en segundo plano se pueden descartar (#3203); las descripciones largas de skills se truncan a una sola línea con el texto completo al pasar el cursor (#3253).
