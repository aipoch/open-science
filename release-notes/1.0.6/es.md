## ✨ Highlights

- **Importe su biblioteca de Zotero.** La biblioteca Literature incorpora Importar desde Zotero: traiga una biblioteca personal o colecciones seleccionadas de Zotero 10 o posterior en el mismo equipo, conservando los metadatos bibliográficos, los PDF, las etiquetas, las jerarquías de colecciones y los enlaces de origen, con las referencias existentes emparejadas en lugar de duplicadas. (#3949)
- **El orden de lectura del PDF es automático.** Al abrir un PDF vinculado ya no se muestran controles persistentes de orden de lectura sobre el documento. La extracción prefiere las etiquetas lógicas propias del archivo y recurre al análisis de diseño cuando faltan o son ambiguas, y los mensajes históricos con regiones manuales también se leen con el nuevo orden automático. (#3979)
- **La instalación en Windows es más rápida y segura.** La instalación baja de una mediana de ~21 s a ~14 s con un tercio menos de archivos de carga y extracción en paralelo, las actualizaciones ya no eliminan los datos de investigación almacenados junto a la aplicación, y las instalaciones en rutas de carpetas profundas se completan en lugar de fallar en el paso de copia. (#3957, #3963, #3946)
- **Los turnos largos conservan sus artefactos.** La publicación de artefactos ya no caduca a las dos horas de un turno del asistente aún en curso: las capacidades ahora viven durante todo el turno abierto, de modo que las sesiones nocturnas y por lotes largos publican sus archivos como antes. (#3980)

## 🚀 New Features

- Busque en la biblioteca Literature por notas personales: una nota como «este método se ajusta a mis datos» ahora encuentra su referencia a través del cuadro de búsqueda normal. (#3942)
- Los conectores stdio personalizados configurados con npx o npm ahora se ejecutan en equipos sin esos comandos, usando el runtime de Node y npm incluido con la aplicación, mientras los comandos instalados mantienen prioridad. (#3954)

## 🔧 Improvements

- Los PDF traducidos se abren más rápido: la verificación de origen de traducciones guardadas ahora se solapa con las lecturas en pequeños lotes al primer abrir, y el worker de traducción local sin uso se eliminó de la instalación, reduciendo su tamaño. (#3982, #3978)
- Las observaciones de cola, controlador y contabilidad de Slurm se resuelven de forma independiente; los resultados finales de los trabajos se conservan antes de la recolección de registros, las cancelaciones entregan exactamente un resultado final, y los comandos SSH cortos en Windows ya no se cuelgan con un canal de entrada inactivo. (#3937)
- Los menús de botón dividido — envío/encolado/detención de conversación, aprobaciones de permisos, selección de conversación de Literature, marcado de PDF y herramientas de área — comparten un panel conectado con colocación automática, animaciones reversibles y botones principal y de flecha utilizables de forma independiente. (#3925)
- Las alertas de seguridad notificadas se abordan con actualizaciones de dependencias compatibles y análisis acotado en lugar de la correspondencia de patrones propensa a retrocesos. (#3956)
- La guía de configuración de WSL ahora indica de entrada que la red en modo espejo requiere Windows 11 22H2 o posterior, en lugar de aconsejar un modo que Windows 10 no puede ofrecer. (#3945)
- La autorización interactiva de credenciales espera hasta cinco minutos por su aprobación, y la recuperación de tiempo de espera explica lo ocurrido en lugar de parecer un problema de clave faltante. (#3939)

## 🐛 Bug Fixes

- Las sesiones de OpenCode ya no terminan con un error interno cuando el nombre de una llamada de herramienta llega tras su primer fragmento de salida, los resúmenes de compactación de la 1.x se mantienen fuera de las conversaciones y del historial reproducido, y las configuraciones grandes ya no fallan al iniciarse en Windows. (#3970, #3967, #3948)
- El arranque en Windows acepta almacenes de cookies con campos de carga binaria en lugar de bloquear la verificación previa de lanzamiento con un fallo de descifrado. (#3955)
- Las sesiones R nativas de Windows funcionan cuando el directorio temporal de la aplicación contiene espacios. (#3958)
- La ventana de escritorio ya no pierde sincronización cuando llega una lectura de instantánea de sesión mientras todos los canales de transferencia grandes están ocupados. (#3969)
- Al enviar un primer mensaje ya no se muestra el pensamiento y el tiempo transcurrido antes de que realmente envíe, y al detener la preparación se restaura su borrador sin enviar. (#3931)
- Las sesiones importadas muestran los fallos de entrega pasados como historial contraído y ampliable en lugar de un error actual sobre la acción de bifurcación. (#3941)
- La barra de herramientas de vista previa de DOCX permanece sobre el contenido del documento al desplazarse, con cualquier nivel de zoom. (#3743)
