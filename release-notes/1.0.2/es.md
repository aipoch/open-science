## ✨ Highlights

- **Cinco nuevos Scientific Connectors, además de un soporte más profundo de GDC y Ensembl.** El catálogo ahora alcanza la nomenclatura génica de HGNC, las anotaciones bibliográficas de PubTator 3, las interacciones fármaco-gen de DGIdb, los registros de ARN no codificante de RNAcentral y un nuevo conector de enfermedades raras de Orphadata (desactivado de forma predeterminada, se habilita por Specialist o Main). Las búsquedas de archivos y casos de GDC incluyen metadatos de muestra, alícuota y flujo de trabajo tumoral/normal, de modo que los resultados de distintas biomuestras ya no se mezclan bajo un mismo caso, y la herramienta Ensembl VEP acepta notación de variantes HGVS directamente en lugar de exigir una conversión manual a coordenadas. (#3738, #3744, #3732)
- **Las tarjetas de respuesta le dicen la verdad sobre cuántas respuestas puede dar.** Las preguntas de opción ahora muestran correctamente una etiqueta de selección única o selección múltiple en lugar de dar a entender siempre que se permiten varias selecciones, cada pregunta respondida dentro de un grupo muestra su propio texto completo y respuesta en lugar de quedar colapsada bajo un recuento compartido, y al expandir una respuesta anterior se revela su lista completa de opciones. (#3690)
- **Los diálogos de paquetes de sesión dejan de moverse.** El diálogo de importación/exportación `.science` ya no cambia de tamaño ni de posición a medida que cambian los pasos y los contadores: mantiene una posición estable y se ajusta al tamaño de su contenido. (#3747)
- **Carga de sesiones más rápida en proyectos grandes.** Al abrir sesiones con mucho historial se omiten los análisis de consistencia redundantes en una recarga limpia y se almacenan en caché las consultas costosas, lo que reduce el tiempo de hidratación y arranque sin debilitar las comprobaciones de recuperación que se ejecutan tras un cierre incorrecto. (#3718)
- **Parches de seguridad para el runtime de Node incluido, y el primer lanzamiento de la CLI en npm.** Las compilaciones de escritorio y de la CLI independiente ahora incluyen Node 22.23.4 y una biblioteca de red Undici actualizada, cerrando los avisos de seguridad de Node.js de octubre. La CLI independiente y el Task SDK ahora también se pueden instalar mediante `npm install --global @aipoch/open-science`, junto con el tap de Homebrew ya existente. (#3751, #3750)

## 🚀 New Features

- La CLI incorporó los comandos locales `version`, `help` y `paths`, que informan de la versión de la aplicación instalada, la ayuda de comandos y las ubicaciones del directorio de configuración sin necesitar un servicio en ejecución. (#3752)
- Cinco nuevos Scientific Connectors: nomenclatura génica de HGNC, anotaciones bibliográficas de PubTator 3, interacciones fármaco-gen de DGIdb, registros de ARN de RNAcentral y asociaciones de enfermedades raras de Orphadata (Orphadata está desactivado de forma predeterminada). (#3738)
- Las búsquedas de archivos y casos de GDC pueden filtrarse por caso, tipo de muestra y flujo de trabajo de análisis, y los resúmenes incluyen metadatos vinculados de muestra, alícuota y flujo de trabajo. (#3744)
- La herramienta del conector Ensembl VEP acepta notación HGVS (por ejemplo, un cambio de codificación de un transcrito) directamente, junto con identificadores de variantes y coordenadas genómicas. (#3732)
- Mencionar un artefacto con `@` ahora funciona desde clientes de chat web remotos, no solo desde la aplicación de escritorio local. (#3719)

## 🔧 Improvements

- Las sesiones de Codex que usan modelos de suscripción ahora obtienen aplicado el tamaño real de la ventana de contexto del modelo, y el uso reportado refleja la capacidad propia de Codex en lugar de un valor predeterminado inflado. (#3739)
- Los diálogos de error de acceso a carpetas y de concesión de permisos de carpeta conservan el mensaje de error específico y traducido en lugar de reducir todos los fallos a un mensaje genérico, y ya no recortan sus botones de acción tras mostrar un error. (#3710)
- Los resultados de exportación de diagnósticos permanecen visibles en un área fija en lugar de quedar empujados bajo una lista de archivos con desplazamiento, y las exportaciones parciales se muestran como advertencias en lugar de parecer éxitos completos. (#3741)
- Importar 257 o más Skills instaladas a la vez ya no falla directamente: las selecciones grandes ahora se envían por lotes. (#3711)
- Importar una Skill externa cuyo nombre empieza con un prefijo reservado ahora tiene éxito con un nombre local seguro en lugar de quedar filtrada silenciosamente del catálogo. (#3712)
- Soltar una carpeta en el compositor de mensajes ahora muestra un aviso claro para seleccionar los archivos que contiene, en lugar de preparar la carpeta y fallar con un error confuso. (#3709)
- Los borradores y el trabajo en curso están mejor protegidos: los formularios de configuración de Connector y Compute ya no pierden la entrada no guardada por completados obsoletos, los errores de mensajes en cola se muestran con una opción de deshacer, y la aplicación advierte antes de salir o recargar con mensajes sin enviar. (#3722)
- Cambiar de conversación mientras un mensaje a otra conversación todavía se está enviando ya no hace que la vista vuelva a saltar a esa otra conversación. (#3706)

## 🐛 Bug Fixes

- Las credenciales de modelo/conector caducadas o no válidas ahora muestran una ruta de recuperación específica en lugar de un error de autenticación sin procesar, y el compositor se deshabilita solo mientras la recuperación es realmente necesaria, de modo que no se pierden borradores ni respuestas en curso. (#3737)
- Una pregunta persistente que falló antes de ser registrada, o una que quedó pendiente de un turno ya finalizado, podían ocultar erróneamente el compositor detrás de una tarjeta de pregunta obsoleta; ambos casos ya están resueltos y el compositor vuelve a aparecer. (#3734, #3725)
- Eliminar una colección de Literature con una subcolección que comparte su nombre ya no informa incorrectamente de un conflicto de nombres ni bloquea la eliminación. (#3736)
- Las vistas previas de DOCX ya no reinician los contadores de listas numeradas a mitad de documento y ahora representan los bordes de tabla de forma consistente con los editores de documentos de escritorio. (#3735)
- La lectura de PDF conserva los recortes de figuras, los pies de figura y la estructura de tablas de forma más fiel, y el contenido en modo lector se clasifica y organiza con mayor precisión para PDF científicos complejos. (#3727)
- Fiabilidad de los paquetes de sesión (`.science`): reintentar una importación parcialmente confirmada ya no crea una sesión duplicada, editar el título de una sesión importada ya no es rechazado por la protección de solo lectura, la evidencia de ejecución duplicada dentro de un archivo se comparte en disco en lugar de copiarse por cada referencia, y los fallos de exportación conservan un diagnóstico específico en lugar de un mensaje genérico de falta de espacio en disco. (#3694, #3733)
- El seguimiento de dependencias y linaje de archivos de los notebooks es más preciso a través de lecturas, transformaciones y exportaciones de CSV encadenadas, tanto en celdas de análisis de Python como de R. (#3728)
- La finalización de un artefacto grande que agotó el tiempo a mitad de transacción ya no informa de un fallo cuando la escritura subyacente ya se había confirmado. (#3717)
- El conector integrado MiniMax M3.1 ya no falla cuando se usa a través de Codex. (#3731)
- Los fallos de inicialización de Codex ahora conservan el error de arranque real en los diagnósticos en lugar de solo una advertencia de limpieza genérica. (#3726)
- Salir de la aplicación mientras se interrumpe la conexión local ya no se queda atascado ni muestra dos diálogos de error contradictorios. (#3704)
- Una sesión recuperada tras una migración de almacenamiento podía quedar atascada como ocupada incluso después de reanudarse correctamente; los reintentos ahora se admiten de forma correcta. (#3705)
- La aplicación podía, en raras ocasiones, no iniciarse porque un archivo de diario de SQLite parcialmente escrito e inofensivo se identificaba erróneamente como dañado; esto ahora se reconoce correctamente, de modo que el arranque continúa. (#3701)
- Salir de la aplicación durante una confirmación de base de datos ya no impide un cierre limpio. (#3703)
- En Windows, un archivo de permisos del sandbox de red del espacio de trabajo bloqueado podía quedarse atascado y no recuperarse; el estado de los permisos ahora se conserva hasta que termina la limpieza. (#3721)
