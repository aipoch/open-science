## ✨ Highlights

- **Importe paquetes `.science` directamente desde su navegador.** Ahora una página de descarga puede entregar un paquete de investigación a la aplicación de escritorio con un solo clic: la aplicación lo recibe y valida automáticamente, y después usted elige su destino y confirma la importación. Tanto el arranque en frío como una aplicación ya en ejecución están contemplados, y las transferencias fallidas informan de lo ocurrido con errores estructurados y accionables. (#3493)
- **Actualizaciones que puede seguir — y de las que confiar, especialmente en Windows.** La descarga, la preparación y el preliminar de la instalación ahora permanecen en un solo diálogo con notas de versión con desplazamiento independiente, en lugar de cuadros de diálogo que cambian bajo sus ojos. El proceso de actualización en Windows ya no duplica el instalador con un proceso de progreso separado, mantiene la propiedad de los sucesores lanzados desde el Explorador y deja de recopiar miles de archivos en cada actualización; además, al salir se espera a la limpieza de los notebooks, y el arranque en frío ya no informa de un fallo de red antes de que la aplicación esté lista. (#3653, #3633)
- **Correcciones de seguridad en la gestión de credenciales OAuth de MCP.** Las credenciales OAuth almacenadas ahora se vinculan al servidor de autorización que las emitió antes de su uso, e incluyen actualizaciones de seguridad de terceros. (#3668)
- **Las sesiones que le esperan siempre se muestran como en espera.** Una sesión pausada a la espera de su aprobación o respuesta ya no vuelve a parpadear como En ejecución: en Home, en la barra lateral, en las acciones del espacio de trabajo y en el encabezado de la conversación, y se mantiene tras reiniciar la aplicación y con actualizaciones del entorno de ejecución. (#3574)

## 🚀 New Features

- El conector PDC recupera metadatos clínicos públicos a nivel de caso — datos demográficos, diagnósticos, información del tumor y referencias de muestra — de la última versión del estudio o de una versión específica. (#3614)
- La selección de skills ahora puede tener en cuenta las imágenes adjuntas a su mensaje actual, no solo el texto. (#3595)
- MiniMax M3.1 Flash, el modelo publicado con un contexto de 1M de tokens y entrada multimodal, está disponible en ambas regiones de MiniMax. (#3670)
- Haga doble clic en una sesión de la barra lateral del espacio de trabajo para abrir el editor de sesiones, sin tener que pasar por el menú de acciones. (#3650)

## 🔧 Improvements

- En el espacio de trabajo web independiente, Compute se habilita cuando las API de notebook y de cómputo que necesita están disponibles, en lugar de permanecer deshabilitado. (#3638)
- Settings vuelve a abrirse en la sección General, y los selectores de proveedor se deshabilitan mientras se guarda. (#3647, #3646)
- La validación de credenciales en el arranque de Windows muestra diagnósticos en lugar de fallar en silencio. (#3631)
- Las superficies emergentes (popover) se alinean con los colores del tema activo. (#3667)

## 🐛 Bug Fixes

- Al salir de la aplicación mientras una pregunta nativa del proveedor estaba en espera, esta ya no se cancela permanentemente: tras reiniciar, todavía puede responderse. (#3672)
- Al detener una conversación mientras su nuevo mensaje se estaba guardando, ese mensaje detenido ya no llega al proveedor. (#3660)
- Los identificadores de actividad repetidos en el arranque de MCP ya no impiden que se guarden los cambios de conversación. (#3628)
- La recuperación en el arranque mantiene su autoridad de reintento, las vistas de la biblioteca recuperadas se actualizan y los diálogos de recuperación ya no se apilan unos sobre otros. (#3579)
- Las ediciones de memoria realizadas mientras hay un guardado pendiente se conservan en lugar de descartarse, y las ejecuciones de notebook completadas ya no se reportan erróneamente como interrumpidas tras un reinicio. (#3571)
- Los comandos manuales del terminal siguen visibles en la vista Main Agent incluso cuando hay un subagente seleccionado. (#3611)
- La lectura de PDF sigue mejorando: la prosa en dos columnas conserva el orden correcto, la pertenencia de figuras y tablas permanece con el elemento correcto, los diseños del lector traducidos se representan correctamente y la búsqueda en PDF ahora le avisa cuando su cobertura es incompleta. (#3605, #3622, #3644, #3654, #3603)
- Literature: las tarjetas de herramientas guardadas se actualizan con el estado actual de la biblioteca, la pantalla completa de la tabla usa la fuente correcta y el estado de guardado se actualiza de forma fiable. (#3645, #3629)
- Importación de paquetes de sesión: los paquetes se pueden soltar en la página de inicio del proyecto, las comprobaciones y el progreso de la importación son más claros y los diálogos anidados se desplazan correctamente. (#3649, #3648, #3673)
- Al editar el cuerpo de un skill ya no se sobrescriben los nombres o descripciones editados por separado, y las búsquedas de anticuerpos respetan sus límites de resultados configurados. (#3570)
- La revisión automatizada espera a que los servidores MCP estén listos y verifica la autenticación enrutada antes de continuar. (#3597, #3627)
- La persistencia de guardar-como-skill está limitada a la sesión que la creó. (#3594)
- La edición de sesiones en móvil mantiene su comportamiento de doble clic. (#3651)
- Al recrear el entorno de ejecución del agente en medio de una sesión, las nuevas actividades de skills ya no colisionan con las históricas — una colisión anterior bloqueaba la liquidación del turno y los mensajes posteriores. (#3682)
- Las sesiones con muchas revisiones vuelven a cargar su historial de revisiones: antes, el historial completo superaba el presupuesto de transporte y bloqueaba el panel de revisiones; ahora los registros de revisión individuales se abren bajo demanda. (#3677)
