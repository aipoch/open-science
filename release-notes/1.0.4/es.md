## ✨ Highlights

- **Las descargas son significativamente más pequeñas.** Las cargas de runtime de la CLI y del escritorio se reducen al podar los componentes generados sin usar, empaquetar el trabajador de traducción con su runtime compacto, incluir un único gestor de entornos empaquetado y eliminar distribuciones alternativas sin uso, sin quitar archivos de runtime activos ni diagnósticos. (#3863, #3867)
- **La CLI independiente ahora habla MCP.** Las herramientas de investigación se exponen a través de un servidor MCP local para clientes MCP externos, bajo los permisos existentes del perfil seleccionado; no es un sandbox independiente ni una vista de solo lectura, por lo que un cliente conectado puede persistir escrituras o incurrir en costes de modelo. (#3862)
- **Las conversaciones largas se leen con claridad.** Una vez que un turno se estabiliza, los mensajes intermedios se contraen para no estorbar mientras el trabajo en ejecución, en espera e interrumpido permanece visible; los grupos de herramientas se contraen en resúmenes, y la búsqueda, las anotaciones y el buscador nativo siguen revelando el contenido oculto cuando lo necesita. (#3868, #3866)
- **Literature incorpora verificaciones de integridad.** Las referencias con DOI pueden comprobarse bajo demanda contra Crossref para detectar retractaciones y correcciones, con los resultados y las horas de comprobación guardados en la referencia. La cobertura es incompleta: no encontrar avisos no demuestra que una referencia no se vea afectada. (#3870)

## 🚀 New Features

- La CLI independiente expone sus herramientas de investigación a través de un servidor MCP local para clientes de herramientas externos. (#3862)
- Las tarjetas de pregunta admiten acciones de omisión estructuradas con controles fijos y predecibles. (#3813)
- Las referencias de Literature admiten comprobaciones de retractación y corrección explícitas por referencia a través de Crossref, iniciadas manualmente y solo para entradas con un DOI válido. (#3870)
- Los artefactos ahora pueden importarse desde carpetas que ha autorizado; la aplicación lee el archivo concedido y conserva una copia inmutable persistente en su almacenamiento de artefactos gestionado. (#3882)
- El flujo de trabajo de importación de GitHub Skills puede guardar repositorios para reutilizarlos. (#3878)
- Las transcripciones de conversación contraen los mensajes intermedios después de que un turno se estabiliza, con un atajo de teclado y revelación completa mediante búsqueda, anotaciones y buscador nativo. (#3868)
- La actividad de herramientas en la transcripción se contrae en grupos, con las herramientas en ejecución resumidas mientras trabajan. (#3866)

## 🔧 Improvements

- Las descargas de la CLI y del escritorio son más pequeñas en todas las plataformas gracias a cargas de runtime podadas, un trabajador de traducción compacto empaquetado y un único gestor de entornos empaquetado. (#3863)

## 🐛 Bug Fixes

- Se restaura la ejecución estándar del notebook en Windows. (#3872)
- El runtime tokenizer lite se conserva de nuevo en las compilaciones empaquetadas. (#3867)
- La exportación del paquete de sesión ya no se queda esperando en el paso de selección de ubicación de guardado después de realizar una selección. (#3874)
- El diálogo de acceso a carpetas de ajustes y su paso de limpieza ya no compiten entre sí. (#3877)
- Los selectores de ask-user ya no entran en bucle tras un fallo de continuación. (#3879)
- Replay presenta los resultados automáticos como eventos del sistema en lugar de mensajes ambiguos. (#3881)
