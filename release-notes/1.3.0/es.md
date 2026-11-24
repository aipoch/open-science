## ✨ Highlights

- **Tareas de investigación programadas.** Configure programaciones recurrentes o puntuales que lanzan sesiones y tareas de Notebook por sí solas: cada ejecución se abre en el espacio de trabajo como su propio registro, y usted mantiene el control con un historial de ejecuciones claro. (#4380)
- **Generación y edición de imágenes.** Genere imágenes a partir de un prompt con su proveedor configurado y luego itérelo: cada edición conserva una versión nueva, de modo que puede comparar, revisitar y reutilizar variantes anteriores en todo el proyecto. (#4424)
- **Presentaciones editables.** Los archivos de PowerPoint se abren para su edición: revise el texto con formato (fuentes, tamaños, colores, alineación) y mantenga la estructura del archivo intacta, todo dentro de la aplicación. (#4392)
- **Películas de investigación, reproducidas.** Las operaciones de película pueden reproducirse en ramas nuevas con resultados independientes, las películas se abren directamente desde el menú de sesión y el diálogo de película explica el uso de tokens antes de generar. (#4389, #4414)
- **Preguntas de agente más inteligentes.** Cuando el agente necesita su aportación, ahora presenta las concesiones entre las opciones que ofrece, para que decida con las consecuencias a la vista. (#4357)

## ⚠️ Alcance y seguridad

- **Las tareas programadas se ejecutan con los permisos de su proyecto.** Una programación lanza su sesión o ejecución de Notebook sin una confirmación adicional mientras la aplicación está en marcha. La ejecución actúa con las carpetas, credenciales y acceso de red ya concedidos a ese proyecto, y consume la cuota de su proveedor configurado. Revise el destino y la cadencia de la programación, así como las concesiones del proyecto, antes de activarla, y pause o elimine las programaciones que ya no desee. Consulte la [frontera de tareas programadas en el registro de limitaciones conocidas](https://github.com/aipoch/open-science/blob/v1.3.0/docs/known-limitations.md). (#4380)
- **La generación y edición de imágenes revela los prompts y las imágenes de origen a su proveedor configurado.** Las solicitudes de generación y las imágenes utilizadas como fuente se transmiten a través de la conexión del proveedor que usted configuró, y cancelar o eliminar localmente no puede retirar los datos que el proveedor ya ha recibido. Revise las condiciones de datos del proveedor antes de generar a partir de material sensible. Consulte [receptores de datos](https://github.com/aipoch/open-science/blob/v1.3.0/docs/security.md#data-recipients). (#4424)

## 🚀 New Features

- Cree tareas programadas que lanzan una sesión o ejecutan un Notebook con una cadencia recurrente o puntual: cada ejecución programada se abre en el espacio de trabajo como su propio registro, y el historial de ejecuciones se conserva por programación. (#4380)
- Genere imágenes a partir de prompts a través de su proveedor configurado y edítelas con instrucciones de seguimiento: cada generación y edición almacena una nueva versión del artefacto, y las variantes anteriores siguen disponibles para compararlas y reutilizarlas. (#4424)
- Edite presentaciones de PowerPoint en su lugar: seleccione y revise el texto con fuentes, tamaños, colores y alineación mientras la estructura de la diapositiva se conserva. (#4392)
- Reproduzca las operaciones de una película de investigación en otra rama y obtenga un resultado independiente sin tocar la película original. (#4389)
- Abra las películas de investigación generadas directamente desde el menú de sesión y vea de antemano una explicación de cuántos tokens usará la generación de la película. (#4414)
- Supervise los procesos de Notebook en ejecución desde la aplicación y detenga los que pertenecen a la aplicación cuando ya no se necesiten. (#4399)
- Los skills de documentos y figuras vienen listos para usar: sus bibliotecas de soporte se preinstalan en el entorno gestionado en el primer uso en lugar de fallar a mitad de tarea. (#4411)

## 🔧 Improvements

- Los historiales de conversación largos se persisten de forma incremental, de modo que las sesiones grandes se guardan continuamente, se recargan más rápido y permanecen receptivas a medida que crecen. (#4378)
- La aplicación alcanza la página principal del proyecto antes al inicio al recortar el trabajo que bloqueaba la primera pantalla. (#4398)
- La generación de películas detenida, las transferencias de paquetes de investigación y las entregas en segundo plano se recuperan por sí solas en lugar de esperar a un reinicio. (#4372)
- Las instalaciones y actualizaciones de Windows usan una canalización de empaquetado más ligera y fiable, y las comprobaciones de preparación de actualización están acotadas para no poder bloquear el flujo. (#4420, #4417)
- La programación de recuperación de destinos de cómputo se ejecuta bajo demanda en lugar de con un temporizador fijo, lo que reduce la sobrecarga en reposo. (#4375)
- Las referencias de skills se alinean con los nombres públicos de skills de OpenCode 2.x, de modo que los skills importados se resuelven como se espera. (#4355)
- Los PDF externos recuperan su estructura nativa con más fiabilidad durante el análisis y la traducción, el lector consolida su barra de herramientas, y los límites de soporte de imágenes se explican por sí mismos en lugar de fallar en silencio. (#4361, #4360, #4435, #4407, #4394, #4400)
- El compositor mantiene los controles de envío accesibles en diseños estrechos, muestra el uso del contexto con precisión y revela la flecha de desplazamiento hasta el final al pasar el cursor sobre la conversación. (#4367, #4403)
- La primera pintura de conversaciones largas está acotada, de modo que la ventana se abre rápidamente incluso con muchos mensajes cargados. (#4376)

## 🐛 Bug Fixes

- Las sesiones conservan su numeración correcta cuando se reparan los registros, y la reproducción del diario ya no repite trabajo ni vuelve a explorar el historial innecesariamente. (#4368, #4432, #4428)
- Los runtimes del agente liberan sus recursos a lo largo de los ciclos de vida del agente, de modo que las ejecuciones repetidas no acumulan sobrecarga. (#4396)
- Las recargas de skills ya no interrumpen la creación de sesiones en curso. (#4427)
- Los traspasos del agente conservan sus metadatos incluso cuando los resultados de herramientas se truncan. (#4413)
- Las descargas de artefactos a través del CLI local ya no agotan el tiempo de espera mientras los datos siguen llegando. (#4430)
- Las solicitudes y descargas de tareas remotas respetan la vida útil de quien las invoca, de modo que las operaciones abandonadas se detienen con prontitud. (#4390)
- Los trabajos de Ray de terminal se eliminan después de la recolección en lugar de permanecer en el destino. (#4386)
- Los enlaces de recursos de ACP se aceptan de nuevo. (#4381)
- Los paquetes de ciencia abren el modo de película importado disponible en lugar de fallar. (#4419)
- Las vistas previas conservan su identidad de nombre de archivo en superficies estrechas, las marcas de ejecución se colocan en las posiciones correctas y el conmutador de proyectos mantiene su desplazamiento dentro de la lista. (#4401, #4350, #4405)
- Las transcripciones del marco de Notebook se paginan de forma estable, y las notas al pie de Markdown mantienen su desplazamiento contenido. (#4370, #4391)

## 🙏 Agradecimientos

- Gracias a [@cyj1116](https://github.com/cyj1116) por las presentaciones editables ([#4392](https://github.com/aipoch/open-science/pull/4392)), las mejoras del lector de PDF ([#4394](https://github.com/aipoch/open-science/pull/4394)), la preservación de metadatos en traspasos ([#4413](https://github.com/aipoch/open-science/pull/4413)) y las correcciones del tiempo de espera de descargas del CLI ([#4430](https://github.com/aipoch/open-science/pull/4430)).
- Gracias a [@wen2zhou](https://github.com/wen2zhou) por las concesiones de opciones en las preguntas de agente ([#4357](https://github.com/aipoch/open-science/pull/4357)), la supervisión de procesos de Notebook ([#4399](https://github.com/aipoch/open-science/pull/4399)) y la identidad de nombres de archivo en vistas previas ([#4401](https://github.com/aipoch/open-science/pull/4401)).
- Gracias a [@fengdwx](https://github.com/fengdwx) por la persistencia incremental del historial de sesiones ([#4378](https://github.com/aipoch/open-science/pull/4378)).
- Gracias a [@roxi3906](https://github.com/roxi3906) por la estabilidad de la navegación por marcas de ejecución ([#4350](https://github.com/aipoch/open-science/pull/4350)), a [@BobbyLin7](https://github.com/BobbyLin7) por la alineación con los nombres de skills de OpenCode ([#4355](https://github.com/aipoch/open-science/pull/4355)), y a [@daanveer-tech](https://github.com/daanveer-tech) por las actualizaciones del README ([#4433](https://github.com/aipoch/open-science/pull/4433)).
