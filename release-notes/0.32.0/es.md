## ✨ Lo más destacado

- **Anotaciones PDF persistentes y cuadernos de documento.** Las notas y las anotaciones se conservan ahora junto a la versión del archivo a la que pertenecen: estilos de texto, marcas de área, notas de página y de documento, comentarios, colores, etiquetas globales, deshacer y rehacer, e importación de anotaciones nativas de PDF — con exportación a un PDF anotado independiente o a notas en Markdown/CSV mientras los bytes originales permanecen intactos. Los adjuntos de la biblioteca comparten su cuaderno de documento entre referencias, proyectos y sesiones; las cargas y los artefactos de un proyecto lo comparten entre las sesiones del proyecto propietario. (#2853)
- **Exportación de artefactos completa en RO-Crate.** Una versión de artefacto verificada puede empaquetarse ahora como un archivo RO-Crate 1.1 completo junto con sus entradas exactas — los tamaños y las sumas de comprobación declarados se verifican antes de incluir los bytes, el contenido idéntico se desduplica y el contenido en conflicto se rechaza. (#2685)
- **Búsqueda de secuencias con NCBI BLAST.** Las nuevas herramientas asíncronas envían una consulta de nucleótidos o de proteínas a NCBI BLAST, siguen el trabajo hasta su finalización y recuperan el informe en el formato que elija — la búsqueda de similitud para secuencias desconocidas llega así al conector de genomas. (#2829)
- **Descubrimiento ómico más amplio.** Las ejecuciones de ENA pueden descubrirse por organismo, estrategia de biblioteca o palabra clave, con los archivos originales enviados (BAM, CRAM) junto a los FASTQ generados por el archivo; los proyectos de PRIDE exponen listados de archivos paginados; las entradas de UniProt se descubren por nombre génico, frase de proteína y organismo antes de obtener las secuencias. (#2852, #2844, #2857)

## 🚀 Novedades

- La instalación de modelos locales de análisis de PDF recurre a fuentes espejo verificadas cuando la descarga principal no está disponible y las ordena por tiempo de respuesta, de modo que las instalaciones ya no fallan por depender de una única fuente. (#2837)
- La selección de capacidades puede apuntar a un servicio de clasificación propio compatible con TypeSafe — URL del endpoint, ID del modelo y clave de API opcional. Se permiten endpoints de loopback sin clave; los endpoints remotos exigen HTTPS y credenciales. (#2832)
- Step-5 Preview de StepFun se incorpora al catálogo de proveedores con soporte multimodal, una ventana de contexto de un millón de tokens y las regiones China y Global; los proveedores existentes conservan su endpoint histórico. (#2825)
- Las ejecuciones de tareas desatendidas de la CLI pueden renunciar por completo a esperar a una persona, de modo que la automatización nunca se atasca en una aprobación ni en una pregunta que nunca llegará. (#2848)

## 🔧 Mejoras

- El arranque y las conversaciones largas funcionan con menos carga: la recuperación de evidencias se agrupa reutilizando la hidratación de sesiones, el trabajo de presentación de Markdown se aplaza hasta que hace falta, los observadores de markdown prescinden de pasadas redundantes, los observadores de anotaciones se pausan mientras hay streaming activo, las vistas previas de subagentes se cargan solo cuando se muestran y las barras de desplazamiento inactivas se ocultan solas. (#2826, #2629, #2831, #2841, #2822, #2823, #2843)
- El agente clasifica las solicitudes ambiguas de lectura de PDF enlazados en lugar de recurrir siempre a la consulta enfocada, de modo que las solicitudes indirectas sobre el documento completo se leen en su totalidad. (#2828)

## 🐛 Correcciones

- **Sesiones y entorno de ejecución de agentes** — las conexiones de herramientas de OpenCode se aíslan por sesión, de modo que las sesiones hermanas ya no pueden invocar las herramientas de Notebook, de artefactos o de planes de otras (#2856); la propiedad de la recuperación sobrevive a la publicación de artefactos (#2839); los chats laterales acotan sus conversaciones y sus avisos en cola a la ejecución actual de la aplicación (#2827).
- **Cómputo y almacenamiento** — la entrega de cómputo en segundo plano se restablece y la cancelación de trabajos se confirma (#2854); los permisos del sistema de archivos se rechazan tras una limpieza incompleta del Notebook (#2851).
- **Conectores** — gnomAD ya no devuelve conjuntos de datos mitocondriales inadecuados (#2840).
- **Interfaz** — la selección de texto se conserva a través de las superposiciones de anotación de PDF (#2860); la búsqueda rápida de Configuración sitúa el foco y el ancla con precisión (#2570); los anillos de foco de las tarjetas de archivo permanecen totalmente visibles después de cerrar el diálogo de vista previa (#2017); las alertas de recuperación en línea ocupan todo el ancho disponible y colocan las acciones bajo el contenido explicativo (#2850, #2855).
