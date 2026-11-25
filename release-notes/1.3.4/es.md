## ✨ Highlights

- **Vea dentro del Agent integrado.** Los proyectos pueden activar el rastreo del Agent, que exporta trazas correlacionadas de turnos, solicitudes de modelo y ejecuciones de herramientas a un receptor OTLP/HTTP alojado por usted —se admiten recolectores genéricos y Langfuse—, con el nivel de detalle de captura que usted elija. (#4514)
- **Actualizaciones de Windows, sin bloqueos y más pequeñas.** Una actualización dentro de la aplicación ya no se detiene cuando el Agent integrado está en ejecución: el actualizador ahora reconoce los procesos del Agent de la propia aplicación en lugar de fallar de forma cerrada. Las actualizaciones estables de Windows también se aplican de nuevo como deltas compactos del instalador; la v1.3.3 había vuelto al instalador completo. (#4602, #4606, #4611, #4605)
- **Los historiales largos de Notebook siguen siendo rápidos.** Iniciar y finalizar ejecuciones, seleccionar resultados y abrir vistas previas ya no releen todo el historial, y las transiciones de ejecución elegibles se agrupan en puntos de control duraderos. (#4615, #4617)
- **Lecturas de memoria en las que puede confiar.** En macOS, el resumen de Compute ahora coincide con Monitor de Actividad al excluir la memoria en caché; en Windows, se muestra la memoria confirmada respecto a su límite junto a la memoria física. (#4599, #4600)

## ⚠️ Alcance y seguridad

- **El rastreo del Agent envía datos a un receptor que usted configura.** El rastreo del proyecto está desactivado de forma predeterminada y solo se inicia cuando un proyecto lo habilita; para una única ejecución de la CLI, `--otel-traces` (o `otelTraces: true` en el SDK) es una opción explícita por ejecución que no requiere el interruptor del proyecto. En ambos casos, las trazas —estructura de turnos, solicitudes de modelo y ejecuciones de herramientas con el nivel de detalle elegido— solo van al punto final OTLP/HTTP definido en la configuración de lanzamiento de la aplicación, nunca a un servicio operado por la aplicación. Elija un receptor que usted controle y revise los interruptores de captura antes de activar el rastreo en equipos compartidos. Consulte [receptores de datos](https://github.com/aipoch/open-science/blob/v1.3.4/docs/security.md#data-recipients). (#4514)

## 🚀 New Features

- Los proyectos ganan un interruptor de rastreo del Agent de activación voluntaria: cuando está habilitado y hay un receptor configurado, el Agent integrado exporta trazas JSON OTLP/HTTP correlacionadas de turnos, solicitudes de modelo y ejecuciones de herramientas MCP a recolectores genéricos o a Langfuse. Cuatro interruptores de detalle ajustan lo que se captura, y un interruptor local de estado de subida informa de la salud de la entrega. (#4514)
- Las conexiones de CodeBuddy descubren los esfuerzos de razonamiento admitidos por cada modelo durante el inicio de sesión y la actualización del catálogo; el selector de esfuerzo luego solo ofrece los niveles que el modelo seleccionado realmente admite. (#4619)
- El catálogo de modelos de Zhipu ahora incluye GLM-5.4, disponible directamente en las conexiones de Zhipu. (#4637)

## 🔧 Improvements

- Los historiales largos de Notebook cuestan menos: una vista de historial acotada y validada sustituye las relecturas completas repetidas al iniciar o finalizar una ejecución, seleccionar resultados o abrir vistas previas, y las transiciones de ejecución elegibles se escriben en ranuras duraderas por carril que se integran en puntos de control. (#4615, #4617)
- El resumen de sistema de Compute se alinea con la contabilidad nativa de cada plataforma: el uso de macOS coincide con Monitor de Actividad (memoria en caché excluida), y Windows muestra la memoria confirmada respecto a su límite con umbrales predeterminados ajustados. (#4599, #4600)

## 🐛 Bug Fixes

- En Windows, una actualización dentro de la aplicación ya no se detiene cuando el Agent integrado o el asistente de imágenes están en ejecución —ambos se reconocen ahora como asistentes de instalación de la propia aplicación, y el registro de asistentes se aplica automáticamente para que un asistente nuevo nunca pueda pasarse por alto. (#4602, #4606, #4611)
- Las versiones estables de Windows vuelven a publicar el delta de instalador compacto usado para las actualizaciones delta; un delta faltante de una versión ya publicada puede repararse sin volver a distribuir la versión. (#4605)
- Las suscripciones de películas de CodeBuddy ahora preparan correctamente su primera solicitud de modelo, y los chats paralelos del Agent integrado conservan sus puntos de control bajo el perfil propio del chat. (#4616)
- Las versiones generadas de edición de imágenes se abren de forma fiable en la vista previa de imagen completa mientras su versión aún se está publicando. (#4603)
- Los estados HTTP ascendentes explícitos se presentan como hechos del proveedor: un 402 como «Insufficient Balance» ahora muestra una explicación de facturación accionable, conservando el estado y los detalles seguros del proveedor. (#4601)
- En Windows, el primer flujo de trazado de Python ya no se detiene por una barrera de recuperación de kernel residual de un carril no relacionado. (#4620)
- Cuando se deniega una acción de herramienta, el turno ahora termina con una explicación duradera en lugar de quedarse en silencio, y los recuentos de denegación se mantienen distintos del trabajo completado. (#4517)
- Las conexiones de CodeBuddy restauran el modelo seleccionado al reanudar una sesión con historial, de modo que las actualizaciones de uso de tokens siguen llegando. (#4631)
- Las generaciones de películas de investigación permanecen visibles: la conversación se mantiene en Activo con su estado de película mostrado, y un diálogo de película bloqueada puede abrir la conversación que posee la generación. (#4633)
- El Agent integrado acepta continuaciones de herramientas que llevan campos de identidad nulos en lugar de fallar el turno. (#4638)

## 🙏 Agradecimientos

- Gracias a todos los que reportan problemas de actualizaciones, de Notebook y de supervisión de memoria en [Discord](https://discord.gg/zxQAYjReRv), [X](https://x.com/aipoch_ai) y [Discussions](https://github.com/aipoch/open-science/discussions).
- Gracias a [@wen2zhou](https://github.com/wen2zhou) por las contribuciones de rastreo del Agent del ámbito del proyecto y de rastreo por ejecución en la CLI ([#4514](https://github.com/aipoch/open-science/pull/4514), [#4618](https://github.com/aipoch/open-science/pull/4618)).
