<h1 align="center">AIPOCH Open-Science</h1>

<p align="center">
  Entorno de investigación con IA para una ciencia reproducible — de código abierto, centrado en la ejecución local e independiente del modelo.
</p>

<p align="center">
  <a href="https://aipoch.com/open-science/download">
    <img alt="Descargar AIPOCH Open-Science" src="https://img.shields.io/badge/Download-Latest%20Release-2f9e44?style=flat">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Última versión de AIPOCH Open-Science" src="https://img.shields.io/github/v/release/aipoch/open-science?label=Version&style=flat&color=4dabf7">
  </a>
  <a href="https://doi.org/10.5281/zenodo.22252246">
    <img alt="DOI de AIPOCH Open-Science en Zenodo" src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.22252246-0b7285?style=flat">
  </a>
  <a href="https://arxiv.org/abs/2610.17110">
    <img alt="Preprint de AIPOCH Open-Science en arXiv: 2610.17110" src="../images/readme/arxiv-preprint.svg">
  </a>
  <a href="#rendimiento-en-benchmarks">
    <img alt="AIPOCH Open-Science — Resultados de benchmarks" src="../images/readme/benchmark-comparisons.svg">
  </a>
  <a href="https://github.com/aipoch/open-science/releases/latest">
    <img alt="Plataformas macOS Windows Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-4263eb?style=flat">
  </a>
  <a href="../../LICENSE">
    <img alt="Licencia Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-7950f2?style=flat">
  </a>
  <a href="https://aipoch.com/open-science">
    <img alt="Sitio web aipoch.com" src="https://img.shields.io/badge/website-aipoch.com-e8590c?style=flat">
  </a>
</p>

<p align="center">
  <a href="../../README.md"><img alt="README en inglés" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="../zh-Hans/README.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../zh-Hant/README.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="../ja/README.md"><img alt="日本語 README" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
  <a href="../ko/README.md"><img alt="한국어 README" src="https://img.shields.io/badge/한국어-d9d9d9"></a>
  <a href="../fr/README.md"><img alt="Français README" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../ru/README.md"><img alt="README en ruso" src="https://img.shields.io/badge/Русский-d9d9d9"></a>
  <a href="../de/README.md"><img alt="README en alemán" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="../es/README.md"><img alt="README en español" src="https://img.shields.io/badge/Español-d9d9d9"></a>
</p>

> Este documento es una traducción del `README.md` en inglés. En caso de discrepancia, prevalece la [versión en inglés](../../README.md).

[AIPOCH Open-Science](https://aipoch.com/open-science) es un entorno de investigación de código abierto que incorpora inteligencia artificial. Empiece con una pregunta, un artículo científico o un archivo de datos. Describa con sus propias palabras qué quiere averiguar y trabaje con un agente de IA para examinar las pruebas, analizar datos o crear un gráfico.

Para entender cómo se obtuvo un resultado, consulte los datos de entrada, el código y el historial de ejecución disponibles. Para compartir su trabajo, elija las ramas de conversación, las versiones de los archivos, los registros del Notebook y las pruebas de verificación que quiera incluir y expórtelos en un paquete `.science`.

### 💡 AIPOCH Open-Science v1.0.8 — Novedades

_4 de noviembre de 2026_

- **Ajustes**: Pestañas por función organizan la información de la aplicación, los diagnósticos y la ayuda.
- **Importación de bibliografía**: Hasta **100** identificadores DOI, arXiv o PubMed, o enlaces oficiales de artículos, por lote, con normalización y eliminación de duplicados.
- **Resúmenes de estudios con IA**: Presentan la pregunta, la población, los métodos, los resultados principales y las limitaciones, e indican si utilizan el texto completo o el resumen.
- **Recursos de sesión**: Los cinco marcos de agentes liberan los procesos al finalizar las sesiones para reducir la acumulación de memoria.
- **Modelos**: Tencent TokenHub añade Hy4 y rutas DeepSeek V4.1 Flash, además de entrada de imágenes para determinados modelos.
- **Datos científicos y PDF**: Se restablecen las consultas eQTL Catalogue con validación GRCh38 y se mejoran el orden de lectura y la extracción de texto de PDF.
- **Fiabilidad**: Se mejoran la verificación de dependencias de R y la procedencia de artefactos; se corrigen actualizaciones, descargas, red aislada e instalación de Pi.

[Notas completas v1.0.8](https://github.com/aipoch/open-science/releases/tag/v1.0.8)

<p align="center">
 <img width="1920" height="1140" alt="Banner principal de AIPOCH Open-Science: Science, Open to All — un entorno de investigación de IA científica de código abierto, independiente del modelo y autohospedado" src="../images/readme/open-science-banner.png" />
</p>

## Tabla de contenido

- [Inicio rápido](#-inicio-rápido)
- [Paquetes de investigación `.science` de AIPOCH Open-Science](#paquetes-de-investigación-science-de-aipoch-open-science)
- [AIPOCH Open-Science: artículo y cita](#aipoch-open-science-artículo-y-cita)
- [Resultados de benchmarks](#rendimiento-en-benchmarks)
- [Capacidades principales](#capacidades-principales)
- [Proveedores de modelos](#proveedores-de-modelos)
- [Datos, permisos y confianza](#datos-permisos-y-confianza)
- [Desarrollo y empaquetado](#desarrollo-y-empaquetado)
- [Preguntas frecuentes](#preguntas-frecuentes)
- [Colaboradores](#colaboradores)
- [Participe](#participe)
- [Licencia](#licencia)
- [Historial de estrellas](#historial-de-estrellas)

## 🚀 Inicio rápido

### 1. Descargue la aplicación

Abra la [página oficial de descargas](https://aipoch.com/open-science/download) y elija el instalador para su equipo:

| Su equipo                                 | Elija                                              |
| ----------------------------------------- | -------------------------------------------------- |
| macOS 12+: Apple Silicon (M1 o posterior) | El DMG de macOS para Apple Silicon / ARM64         |
| macOS 12+: Intel                          | El DMG de macOS para Intel/x64                     |
| Windows 10/11 x64                         | El instalador de Windows x64 (con firma de código) |
| Linux x64                                 | El paquete AppImage o Debian de Linux x64          |
| Linux ARM64                               | AppImage o paquete Debian de Linux ARM64           |

Consulte la [verificación de descargas](../../SECURITY.md#verifying-your-download) para realizar comprobaciones antes de instalar.

Los archivos de la CLI independiente para macOS, Linux y Windows incluyen Node.js y se pueden usar sin Homebrew ni npm.

En macOS, también puede instalar la aplicación con [Homebrew](https://brew.sh):

```bash
brew install --cask open-science
```

Para la CLI independiente en macOS o Linux, utilice el [tap de AIPOCH](https://github.com/aipoch/homebrew-tap) por separado:

```bash
brew install aipoch/tap/open-science
```

La fórmula incluye Node y no necesita la aplicación de escritorio en ejecución; su versión puede diferir del Cask de escritorio. Consulte los requisitos y las actualizaciones en la [guía del entorno independiente](../standalone-runtime.md).

Para el CLI independiente y la interfaz web, instale el [paquete npm publicado](https://www.npmjs.com/package/@aipoch/open-science) con **Node.js 22.13.0 o posterior**:

```bash
npm install --global @aipoch/open-science
open-science start --no-open
open-science url
```

Abra la URL indicada para completar la configuración o siga la [guía de configuración desde el terminal](../../packages/open-science/CLI.md#first-run-setup-codex). npm admite macOS ARM64/x64, Linux ARM64/x64 con glibc y Windows x64; no requiere la aplicación de escritorio. Mantenga las dependencias opcionales de npm y consulte los [requisitos de Linux y las instrucciones de actualización](../standalone-runtime.md#install-from-npm). La URL contiene un token de autenticación; manténgala privada.

En Windows, reinstalar conserva los datos de investigación. Para una limpieza completa, consulte la [herramienta de restablecimiento](../../scripts/windows-reset/README.md), que elimina permanentemente los datos locales tras la confirmación.

### 2. Complete la configuración inicial

Siga el asistente: **Entorno → Ubicación de datos → Entorno de ejecución del agente → Proveedor de modelo → Entorno de ejecución de Notebook**.

Complete las comprobaciones obligatorias del entorno y del runtime del agente y pruebe la conexión al modelo. Python/R Notebook es opcional; Notebook y la ubicación de datos pueden ajustarse más adelante en Configuración.

En los ajustes del sistema encontrará las opciones de apariencia y notificaciones. La sección **General** incluye la guía de instalación y actualización manuales.

<table>
<tr>
<td width="50%"> <img src="../images/readme/onboarding-environment.jpg" alt="Comprobaciones automáticas del entorno durante el primer inicio de AIPOCH Open-Science"> </td>
<td width="50%"> <img src="../images/readme/onboarding-model-provider.jpg" alt="Configuración del proveedor de modelos durante el primer inicio de AIPOCH Open-Science"> </td>
</tr>
<tr>
<td align="center"> <sub> Comprobaciones de red, almacenamiento y compatibilidad del host </sub> </td>
<td align="center"> <sub> Proveedor, clave API, endpoint y validación de modelo </sub> </td>
</tr>
</table>

### 3. Iniciar un proyecto de investigación

1. Haga clic en **Nuevo proyecto**, abra una sesión y describa el objetivo de investigación, las entradas y los resultados esperados.
2. Adjunte archivos, elija un modelo y un modo de aprobación y envíe la tarea. Use `@` para referenciar archivos del proyecto o `/` para elegir una habilidad.
3. Revise la actividad de las herramientas y las solicitudes de aprobación, previsualice los resultados y consulte la evidencia disponible en **Procedencia**.

> Las capturas de pantalla de este archivo README ilustran el flujo de trabajo. Las etiquetas, catálogos y otros detalles de la interfaz pueden diferir de la versión que instale.

## Paquetes de investigación `.science` de AIPOCH Open-Science

Exporte una sesión de investigación terminada como un paquete `.science` portátil para revisión, traspaso y archivo. Elija las ramas de conversación, versiones de archivos, registros de Notebook y evidencias de verificación que desea incluir, y luego importe el paquete en otro proyecto o equipo.

La exportación y la importación están disponibles en la aplicación de escritorio, las sesiones web locales y la CLI sin interfaz. Las sesiones web remotas no pueden leer ni escribir rutas arbitrarias de paquetes locales.

**Exportar → transferir → inspeccionar**

1. Exporte una sesión terminada y elija el contenido que desea incluir.
2. Transfiera el archivo `.science` a un colaborador o a otro equipo.
3. Importe el archivo en un proyecto. **Research replay**, a la derecha, muestra el proceso registrado; la conversación de la izquierda permite hacer preguntas y citar pasos fijos.

Los registros importados siguen siendo de solo lectura; ver la reproducción no ejecuta código, no llama a modelos ni restaura credenciales. La primera pregunta crea una conversación editable asociada; utilice **Fork to continue** para crear una copia de trabajo. Volver a ejecutar un resultado sigue requiriendo una receta completa, los datos necesarios y un entorno disponible.

Se excluyen las conversaciones Side Chat, los marcadores privados de lectura y las credenciales; los archivos incluidos dependen de la selección de exportación. Los registros de verificación recibidos describen las comprobaciones del remitente, no una nueva ejecución en este equipo. Consulte la [guía de paquetes `.science`](https://aipoch.com/docs/guides/research-packages/).

## AIPOCH Open-Science: artículo y cita

**[AIPOCH Open-Science: An Open-Source AI Research Workbench with Reproducible .science Packages](https://arxiv.org/abs/2610.17110)**

Preprint de arXiv · [v1](https://arxiv.org/abs/2610.17110v1) · Enviado el 12 de octubre de 2026.

Nuestro preprint presenta AIPOCH Open-Science, un entorno de investigación con IA de código abierto que utiliza paquetes `.science` portátiles para compartir el contexto de investigación, las versiones de artefactos y los registros de verificación. Consulte el artículo para conocer el diseño de intercambio de paquetes y la evaluación controlada.

Si utiliza AIPOCH Open-Science en su investigación, puede citar el preprint:

<details>
<summary>Cita BibTeX</summary>

```bibtex
@misc{ouyang2026aipochopenscienceopensourceai,
      title={AIPOCH Open-Science: An Open-Source AI Research Workbench with Reproducible .science Packages},
      author={Wen Ouyang and Bocheng Huang and Qianyu Yao and Fei Sun and Minying Deng and Haoyue Cheng and Wenwen Zhou and Lei Mou and Yusi Wei and Jiang Li and Kun Zhu and Lei Wang and Yi Feng and Jiaheng Dai and Ke Qian and Dan Wang and Yahui Wang and Chenyi Wang and Mingsheng Lyu and Yaqiang Zhang and Ping Zheng and Chunhua Tang and Xinge Ma and Xu Zhang and Youjia Fan and Can Lu and Zhijun Dai and Man Hu and Qiqi Xie and Beinan Liu and Yuanning Guo and Yunze Liu and Jinhong Jiang and Xianjun Fu and Mingwei Zhang and Yuanji Xu and Shilin Xia and Bowen Yang and Mingjun Yu and Jingdun Xie and Xuwei Chen and Xia Zou and Yuzhou Xue and Jianguo Zhou and Chunhao Cao and Donghao Tian and Lei Huang and Jinxiao Li and Shengrong Long and Zefeng Song and Honglin Li and Jiang Luo and Wenying Jiang and Shanshan Li and Lei Dai and Ning Jiang and Ying Cai and Chaohui Li and Chunyan Peng and Hetong Zhao and Angqing Li and Chunyan Yang and Chongyang Sun and Yong Li and Xinyu Shi and Wei Dai and Ming Peng and Chen Sang and Yuanyuan Han and Desong Qiu and Haixin Miao and Jian Xu and Yi Chen and Xiaoliang Shi and Tian Shen and Teng Hu and Shuhao Wang and Yingyong Hou and Huimei Wang},
      year={2026},
      eprint={2610.17110},
      archivePrefix={arXiv},
      primaryClass={cs.SE},
      url={https://arxiv.org/abs/2610.17110},
}
```

</details>

<a id="rendimiento-en-benchmarks"></a>

## Resultados de benchmarks

AIPOCH evaluó AIPOCH Open-Science en tareas que abarcan encontrar un artículo, responder preguntas sobre su contenido y ejecutar un plan de investigación. Los resultados siguientes proceden de ejecuciones propias de AIPOCH. Cada puntuación corresponde a una tarea y una configuración de evaluación concretas.

| Tarea                               | Resultado de AIPOCH Open-Science                                                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Encontrar el artículo objetivo      | En **68 de las 75 preguntas de prueba**, el artículo objetivo apareció entre los primeros 30 resultados de LitQA2-FullText-Search (**90.67% Recall@30**, gpt-6-astra).                                     |
| Responder a partir de la literatura | En una ejecución independiente de LitQA2-FullText, Open-Science respondió correctamente **70 de 75 preguntas** (**93.33% de exactitud**, deepseek-flash con razonamiento Max).                             |
| Elaborar una síntesis con citas     | En 100 preguntas de validación de ScholarQA-CS2, Open-Science obtuvo una **puntuación compuesta de calidad de 0.9289/1** con deepseek-v4-flash. Las referencias de la prueba oficial usan otras preguntas. |
| Ejecutar flujos de investigación    | En ejecuciones locales de ASI-Bench con el mismo modelo, Open-Science obtuvo **59.46** en B4 y Codex **55.45**. En B2 las puntuaciones fueron casi idénticas (**56.11** y **56.09**).                      |
| Analizar datos biomédicos           | En BiomniBench-DA Public 50, dos modelos jueces puntuaron los resultados con **81.04** y **77.06**. Su media con igual ponderación fue **79.05**.                                                          |

### AstaBench — Tareas de literatura

<details>
<summary><strong>Búsqueda de artículos — objetivo encontrado en 68 de 75 preguntas</strong></summary>

AIPOCH ejecutó localmente la partición Test oficial de 75 preguntas de LitQA2-FullText-Search. Su Recall@30 igualó el valor más alto de la instantánea comparativa del 26 de octubre de 2026. Esta ejecución local no fue una presentación a la clasificación oficial ni una posición en ella.

![Comparación de búsqueda LitQA2 de AIPOCH Open-Science: Recall@30 local del 90.67% en la partición Test oficial](../images/readme/astabench-litqa2-test.jpg)

Recall@30 cuenta un acierto cuando el artículo objetivo aparece entre los primeros 30 resultados; no mide la exactitud de las respuestas. Los costes no se calcularon de forma uniforme entre ejecuciones.

</details>

<details>
<summary><strong>Preguntas sobre texto completo — 70 respuestas correctas de 75</strong></summary>

AIPOCH ejecutó la partición Test de 75 preguntas de LitQA2-FullText en AstaBench v0.5.4. El gráfico ordena por puntuación el resultado local y los registros históricos de referencia. Su «#1» se refiere a esa comparación.

![Comparación de respuestas sobre texto completo LitQA2 de AIPOCH Open-Science: exactitud local del 93.33%](../images/readme/astabench-litqa2-fulltext-local-comparison.png)

La exactitud mide las respuestas correctas. Aquí, 93.33% es la exactitud local de respuesta y 90.67% es una exactitud histórica de referencia. El gráfico de búsqueda anterior usa otra métrica. Las referencias se recopilaron el 28 de octubre de 2026; la mayor puntuación de referencia se comprobó de nuevo el 2 de noviembre.

</details>

<details>
<summary><strong>Calidad de respuestas con citas — validación local y referencias oficiales de prueba</strong></summary>

El resultado local de ScholarQA-CS2 mide la calidad de respuestas con citas en 100 preguntas de Validation. Las referencias proceden de Test, por lo que estas puntuaciones no establecen una clasificación de enfrentamiento directo.

![Comparación ScholarQA-CS2 de AIPOCH Open-Science: puntuación compuesta local de Validation de 0.9289, separada de las referencias oficiales de Test](../images/readme/astabench-scholarqa-cs2.jpg)

La puntuación compuesta se expresa en una escala de 0 a 1; no es el porcentaje de preguntas respondidas de forma completamente correcta.

</details>

### ASI-Bench — Seguir un plan y elegir métodos

Las cuatro condiciones piden al agente ejecutar un plan especificado (B1), organizar un flujo de trabajo (B2), elegir métodos (B3) o investigar con información distractora (B4). Las dos primeras filas del gráfico comparan ejecuciones locales con el mismo modelo GPT-6 Astra.

![Resultados ASI-Bench B1–B4 de AIPOCH Open-Science junto a ejecuciones locales de Codex y referencias publicadas](../images/readme/asi-bench-b1-b4.jpg)

Open-Science obtuvo **79.35, 56.11, 59.67 y 59.46** en B1–B4; la referencia local de Codex obtuvo **74.78, 56.09, 58.12 y 55.45**. Las puntuaciones B2 fueron casi idénticas. Otras ejecuciones publicadas difieren en instancias de tareas, configuraciones o evaluación.

La puntuación local B1 cubre 59 tareas tras excluir una por un problema del sistema de puntuación. Se informaron tres repeticiones locales para B1/B2. B3/B4 usaron Open-Science v0.32.0 y un juez sustituto; cada puntuación es la media de tres ejecuciones de 60 tareas.

### BiomniBench-DA — Análisis de datos biomédicos

En el conjunto Public 50, el juez Gemini 3.1 Pro puntuó los resultados con **81.04** y el juez DeepSeek v4-pro con **77.06**. AIPOCH informa de su media con igual ponderación, **79.05**, para la configuración gpt-5.6-sol (xhigh).

<details>
<summary><strong>Puntuaciones de jueces y referencias históricas — cobertura de evaluación variable</strong></summary>

El gráfico combina entradas con distinta cobertura de jueces. Su «#1» describe el orden de esa colección. Una clasificación con un procedimiento común exigiría puntuaciones comparables para todas las entradas.

![Comparación BiomniBench-DA Public 50 de AIPOCH Open-Science con las puntuaciones de los dos jueces y su media](../images/readme/biomnibench-public50-leaderboard.png)

79.05 es una puntuación media de los jueces en esta evaluación interna.

</details>

**Alcance de la evaluación:** estos informes cubren ejecuciones locales o internas de agosto a noviembre de 2026 con los modelos y particiones indicados; no se repitieron para la versión actual. Las referencias son instantáneas históricas, no clasificaciones en tiempo real. Las puntuaciones de distintas familias de benchmarks no son directamente comparables y las diferencias numéricas no establecen significación estadística.

Consulte el [informe de AstaBench y ASI-Bench](https://aipoch.com/benchmark/open-science) y el [informe de BiomniBench-DA](https://aipoch.com/blog/open-science-biomnibench-da) para conocer los detalles.

## Capacidades principales

AIPOCH Open-Science combina gestión de proyectos, ejecución de agentes multimodelo, Notebooks de Python y R, conectores de datos científicos, versiones inmutables de artefactos con procedencia y control humano autorizado en un espacio de trabajo local. La aplicación instalada y las [notas de la versión más recientes](https://github.com/aipoch/open-science/releases/latest) son la fuente de referencia para los catálogos actuales, los detalles de empaquetado y las opciones recién incorporadas.

| Área                                                | Capacidad central                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Habilidades científicas**                         | Amplíe la investigación con **24 habilidades integradas** y **525 habilidades** del [Skills Marketplace](https://github.com/aipoch/openscience-skill-marketplace), con instalación y actualizaciones en un clic. Cree habilidades mediante conversación o trabajo completado, importe paquetes o fuentes de GitHub y guarde repositorios de GitHub para reutilizarlos en el flujo de importación. Guardar un repositorio no instala sus habilidades. Las aportaciones se publican tras revisión; una importación local no las publica.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Conectores**                                      | Acceda a recursos científicos con **48 conectores integrados** o añada conectores MCP locales y remotos personalizados. Algunas fuentes integradas están desactivadas de forma predeterminada y requieren activación voluntaria por fuente. Gestione permisos por herramienta e importe o exporte configuraciones.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Especialistas y delegación**                      | Instale **10 especialistas** del [Specialist Marketplace](https://github.com/aipoch/openscience-specialist-marketplace) o cree especialistas personales para recibir tareas del agente principal. Los paquetes admiten importación y exportación; las aportaciones se revisan antes de publicarse y las importaciones locales no las publican.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Modelos y backends de agentes**                   | Use modelos en la nube, pasarelas compatibles o inicios de sesión de suscripciones Claude y Codex. Elija Claude Code, OpenCode, Codex, CodeBuddy o Pi como backend, con pruebas de conexión, entrada de imágenes y ajustes de razonamiento.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Proyectos, sesiones y paquetes de investigación** | Organice proyectos con sesiones fijadas, ramas de mensajes, conversaciones laterales e historial recuperable. Traslade un **paquete de investigación `.science` portátil** a otro proyecto o equipo con ramas de conversación, versiones de archivos seleccionadas, registros de Notebook y evidencia de verificación. Las importaciones son de solo lectura, sin ejecutar código ni restaurar credenciales; se excluyen conversaciones laterales y marcadores, y los archivos dependen de la selección de exportación.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Agente revisor**                                  | Active la revisión automática opcional para comprobar, en un contexto separado, las respuestas, registros de ejecución y evidencias de archivos relacionados con un turno completado del agente. Obtenga comprobaciones fundamentadas con resultados de aprobación, advertencia o fallo, con un número limitado de ciclos de corrección por el agente principal y nueva revisión cuando se detecten problemas. Se conservan los registros de revisión y el estado de resolución de los problemas; la revisión se limita a los registros disponibles para ese turno.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Python, R, Notebooks y HPC**                      | Ejecute Python, R, Notebook y shell localmente con entornos gestionados o intérpretes propios, con ejecución en segundo plano e historial. SSH y Slurm requieren el host, software, recursos y permisos descritos en la FAQ de cálculo remoto.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Biblioteca de referencias**                       | Importe y gestione referencias y PDF con colecciones, etiquetas, vínculos a proyectos, notas y fusión de duplicados. Descubra referencias y trabajos que citan un artículo mediante Semantic Scholar, descargue y previsualice adjuntos complementarios e importe PDF o archivos bibliográficos mediante arrastrar y soltar. Busque textos completos de acceso abierto, lea PDF, extraiga figuras y tablas y utilice fuentes de la biblioteca para el análisis asistido por IA. Para referencias con DOI válido, consulte manualmente en Crossref retractaciones o correcciones conocidas; la comprobación envía el DOI a Crossref y, dada su cobertura incompleta, la ausencia de aviso no demuestra que el trabajo no esté afectado. Genere bibliografías, exporte referencias en BibTeX o RIS y decisiones de Smart Screening en CSV. Establezca manualmente el estado de lectura como No leído, En lectura o Lectura finalizada, actualice las referencias seleccionadas en lote y filtre por estado. Busque en las notas personales desde el campo de búsqueda de referencias existente. |
| **Archivos científicos y vistas previas**           | Suba archivos de hasta **10 GiB cada uno**, organice los archivos del proyecto y previsualice datos científicos, PDF, documentos Office, imágenes, código y estructuras moleculares. El límite de subida no garantiza que un modelo lea todo el archivo: contexto, análisis de adjuntos y vistas previas tienen límites propios. Los archivos grandes suelen necesitar lectura o análisis por bloques mediante código.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Artefactos y procedencia**                        | Conserve versiones inmutables de resultados con código generador, entradas, historial de ejecución, entorno y evidencia de revisión disponibles. Importe artefactos desde carpetas autorizadas; AIPOCH Open-Science copia cada archivo importado al almacenamiento gestionado de artefactos. En el escritorio, reproduzca versiones aptas con una receta completa, las entradas necesarias y un entorno utilizable, compare salidas y exporte registros de verificación. La falta de evidencia puede impedir la verificación, y reproducir resultados no demuestra validez científica.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Al consultar el eQTL Catalogue por coordenadas, Open-Science comprueba que correspondan al ensamblaje de referencia GRCh38.

Importe referencias, etiquetas, colecciones y enlaces a las fuentes desde Zotero 10 o posterior en ejecución en el mismo equipo. Puede elegir copiar los archivos PDF adjuntos locales; la importación es unidireccional y no modifica Zotero.

Añada una referencia mediante un DOI, un identificador de arXiv, un PMID, un PMCID o un enlace de artículo compatible, o pegue hasta 100 referencias, una por línea. Revise y edite una referencia individual antes de guardar, o seleccione las referencias que desea importar por lotes. Los PDF de texto completo se pueden añadir por separado.

Dispone de anotaciones PDF persistentes y notas de documentos. Con un modelo de cribado configurado, las colecciones inteligentes evalúan referencias según sus criterios de inclusión y exclusión. Las decisiones de IA y las manuales se registran por separado para apoyar la revisión humana.

En el modo de lectura, los agentes pueden enumerar, localizar y crear notas y marcas en los PDF vinculados. Las anotaciones PDF están ligadas a la versión del archivo anotado y no se sincronizan entre equipos.

En la vista de detalle del artículo, el modelo principal configurado resume la pregunta de investigación, la población estudiada, los métodos, los principales hallazgos y las limitaciones. La ficha indica si se basa en el texto completo o en el resumen del artículo.

El OCR opcional reconoce las páginas PDF escaneadas una vez descargados el componente y los paquetes de idioma necesarios. Hay nueve paquetes de idioma disponibles: inglés, chino simplificado, chino tradicional, alemán, español, francés, japonés, coreano y ruso. Los indicadores de cobertura por página muestran qué páginas aún carecen de texto.

Los PDF traducidos pueden refluir de forma opcional el texto del cuerpo y los pies de figura en una disposición de una sola columna centrada en el contenido, conservando imágenes, tablas, fórmulas y bibliografía en su forma original, con correspondencias entre páginas de origen y salida para comparar. En instalaciones nuevas, las restricciones de carpetas de Notebook y la línea de comandos están activadas de forma predeterminada y limitan esos entornos al espacio de trabajo, las carpetas aprobadas y los archivos necesarios para las herramientas; este ajuste no controla las herramientas nativas del agente ni los equipos remotos.

En la aplicación de escritorio también puede exportar la procedencia de artefactos como RO-Crate 1.1. Un paquete de entorno ligado a una versión solo puede crear un entorno gestionado si la captura está completa y es compatible con la plataforma de destino; no es una copia de seguridad completa del equipo.

Explore casos de investigación en el mercado Sharing desde Inicio o desde el espacio de conversación, filtre por categoría, busque por palabra clave y descargue paquetes desde los detalles de cada caso.

## Proveedores de modelos

AIPOCH Open-Science es independiente del modelo a nivel de producto: conéctelo a los principales proveedores de LLM en la nube, una puerta de enlace personalizada o reutilice una suscripción Claude o Codex existente. Actualmente, la disponibilidad del proveedor depende del backend del agente seleccionado y de los protocolos API que admite. Están disponibles las siguientes opciones de conexión:

| Modo proveedor                     | Cómo funciona                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Proveedores de nube integrados** | Elija de la lista de proveedores que muestra la aplicación instalada y autentíquese con la clave solicitada.                                                                                                                                                                                                                                                                                                                                                                 |
| **Puerta de enlace personalizada** | Indique la URL base, el ID exacto del modelo y un protocolo API compatible con el backend elegido (Messages, Chat Completions o Responses), y pruebe la conexión. Las pasarelas remotas requieren HTTPS y clave API. Las direcciones de loopback como `localhost`, `127.0.0.1` o `[::1]` permiten HTTP sin clave; hay ajustes predefinidos para Ollama, LM Studio, llama.cpp y vLLM. El formato API predeterminado no garantiza la compatibilidad del servidor o del modelo. |
| **Suscripción de Codex**           | Seleccione el framework de agentes Codex y luego elija Suscripción de Codex como tipo de proveedor.                                                                                                                                                                                                                                                                                                                                                                          |
| **Suscripción de Claude**          | Inicie sesión con una suscripción de Claude en dos modos: **compartido** (un inicio de sesión en el navegador que almacena las credenciales en el perfil predeterminado `~/.claude`) o **aislado** (un flujo `claude setup-token` gestionado por la aplicación bajo un `CLAUDE_CONFIG_DIR` propio y completamente aislado de `~/.claude/`, con la opción alternativa de pegar un token).                                                                                     |
| **xAI (Grok) OAuth**               | Utilice el inicio de sesión de dispositivo integrado de xAI (Grok) OAuth. El acceso depende de la cuenta de xAI y de los protocolos del backend elegido; valide la conexión en la aplicación.                                                                                                                                                                                                                                                                                |

Hay 25 opciones de proveedor preconfiguradas, incluidos OpenAI, Anthropic, DeepSeek, NVIDIA Build y otros. Los modelos y puntos de acceso regionales dependen de la versión instalada y del backend elegido; consulte el selector y la prueba de conexión de la aplicación.

## Datos, permisos y confianza

AIPOCH Open-Science almacena en el equipo local los datos del proyecto, la configuración, las versiones de los artefactos y la evidencia de procedencia. Las claves API se guardan localmente y utilizan el almacén seguro de credenciales del sistema operativo cuando está disponible. Los registros también son locales y no se cargan automáticamente.

El flujo de datos externos aún es posible y debe revisarse:

- Las solicitudes al modelo envían el prompt y el contexto necesarios al proveedor del modelo seleccionado.
- Las búsquedas web y los conectores remotos envían sus parámetros mostrados a servicios externos.
- Los conectores locales pueden ejecutar comandos de confianza en el equipo.
- La aplicación también puede contactar con servidores de actualización, catálogos del mercado y servicios de descarga de entornos o modelos.
- Los archivos adjuntos, las referencias `@`, los registros y los informes generados pueden contener datos de investigación confidenciales.

Elija el perfil de permiso más limitado que se ajuste a la tarea:

| Modo                                  | Comportamiento                                                                                                                                                               | Uso recomendado                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Solicitar aprobación**              | Solicita aprobación para las acciones no cubiertas por permisos acotados existentes o políticas de herramientas de confianza de la aplicación                                | Flujos de trabajo nuevos, datos confidenciales y scripts desconocidos        |
| **Aprobar ediciones automáticamente** | Usa la revisión automática nativa del backend cuando existe; en caso contrario, solo autoriza automáticamente operaciones claramente de bajo riesgo en el espacio de trabajo | Edición de archivos de confianza con acceso externo controlado               |
| **Acceso completo**                   | Permite automáticamente las ediciones, los comandos, el acceso a la red y los conectores                                                                                     | Trabajo desatendido, de plena confianza y con un alcance claramente definido |

El perfil efectivo depende del backend y de los permisos existentes. También se aplican las políticas de conectores, herramientas y red de cálculo; compruebe el modo efectivo que muestra la aplicación.

Revise los parámetros del conector y la actividad de la herramienta antes de aprobarlos. Nunca incluya claves API, tokens de acceso, identificadores de pacientes, datos no publicados o rutas locales confidenciales en capturas de pantalla o registros de problemas públicos.

## Desarrollo y empaquetado

AIPOCH Open-Science consta de un backend Node convencional y un cliente de escritorio Electron, con React, TypeScript, Prisma/SQLite y un entorno de agentes basado en ACP.

Requisitos previos para desarrollar desde el código fuente:

- Node.js 24 (consulte [`.nvmrc`](../../.nvmrc)) con npm
- Git
- La ejecución de Notebook es opcional y usa entornos Python/R gestionados por la aplicación o un intérprete compatible que usted configure.

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

Consulte la [referencia de comandos de desarrollo y empaquetado](development-quick-reference.md) y la [guía de contribución](../../CONTRIBUTING.md) para los comandos de compilación y el flujo de desarrollo.

### Modos web y sin interfaz gráfica en localhost

La interfaz web funciona con un backend Node independiente, sin Electron ni entorno gráfico.

```bash
npm run dev:web
npm run pack:backend
```

La interfaz web funciona con un backend Node independiente, sin Electron ni entorno gráfico. `npm run dev:web` y `npm run dev:headless` compilan e inician el backend y la interfaz web; no inician el escritorio ni la bandeja. `OPEN_SCIENCE_WEB_PORT` selecciona el puerto (predeterminado `44100`); Ctrl+C cierra el servicio en primer plano de forma ordenada.

El desarrollo desde el código fuente requiere Node.js 24. El paquete npm publicado y el tarball independiente compilado localmente requieren Node.js >=22.13.0. Los archivos de Release, la fórmula Homebrew y el lanzador del escritorio incluyen su propio entorno de ejecución.

La aplicación de escritorio y el navegador comparten el mismo servicio. Las aplicaciones conectadas y una solicitud explícita de mantener el servicio activo mediante `open-science start` lo mantienen en ejecución. Al salir de la última aplicación, el servicio solo se detiene si no queda ninguna solicitud explícita de mantenerlo activo.

[CLI](../../packages/open-science/CLI.md) · [Node](../standalone-runtime.md)

### Acceso remoto móvil

Se puede acceder a la misma interfaz web de localhost desde un teléfono o una tableta mediante el emparejamiento de Remote.It. Empareje un navegador con un código de AIPOCH Open-Science de seis dígitos, apruébelo una vez en el escritorio y el espacio de trabajo permanecerá accesible sin exponer directamente el servidor de loopback. Puede revocar la confianza del navegador; además, los cambios de modo o el cierre del servicio invalidan de inmediato las sesiones remotas activas.

El equipo anfitrión debe permanecer encendido y conectado, con AIPOCH Open-Science y el agente Remote.It en ejecución, y debe estar añadido a una cuenta de Remote.It con sesión iniciada. La autorización del navegador caduca y puede revocarse; consulte la [guía de control remoto](../remote-control.md).

### CLI y SDK sin interfaz gráfica

La CLI sin interfaz gráfica y el SDK de Node.js sin dependencias utilizan el mismo daemon local, así como los mismos proyectos, sesiones, credenciales y permisos que las interfaces web y de escritorio. La documentación detallada se incluye en el paquete publicado y sirve como referencia única de los comandos:

- [Guía CLI](../../packages/open-science/CLI.md): instalación, ciclo de vida del servicio, automatización de tareas, artefactos, formatos de salida y códigos de salida
- [Descripción general del paquete SDK](../../packages/open-science/README.md) - Inicio rápido de Node.js y punto de entrada del paquete

La CLI independiente puede exponer sus herramientas de investigación a clientes MCP externos mediante `open-science mcp`. Primero, inicie y autentique el servicio del perfil seleccionado. El adaptador usa los permisos existentes de ese perfil; no es un entorno aislado ni una vista de solo lectura, por lo que los clientes conectados pueden guardar cambios y generar costes de modelos. No expone acceso arbitrario a shell o RPC, gestión de credenciales, importación o exportación de archivos, descargas a una ruta ni un endpoint MCP HTTP remoto.

## Preguntas frecuentes

<a id="por-qué-falla-la-prueba-de-conexión-del-modelo"></a>

<details>
<summary>¿Por qué falla la prueba de conexión del modelo?</summary>

R: Compruebe que la clave API no tenga caracteres omitidos ni espacios, verifique la URL base y la región, use el ID exacto del modelo indicado por el proveedor y confirme el acceso a la red y el saldo de la cuenta. Para una suscripción de Claude, vuelva a iniciar sesión en el navegador compartido o actualice la credencial aislada `claude setup-token`, según el modo seleccionado.

</details>

<a id="por-qué-continuar-está-deshabilitado-durante-la-instalación"></a>

<details>
<summary>¿Por qué **Continuar** está deshabilitado durante la instalación?</summary>

R: El paso actual no cumple la condición requerida. Corrija cualquier fila del entorno marcada como **Acción necesaria**, instale o repare el entorno de ejecución del agente seleccionado o valide el proveedor del modelo, según el paso activo. La configuración de Notebook es opcional y solo afecta a la ejecución de Notebook.

</details>

<a id="cómo-ejecuto-trabajos-en-un-clúster-hpc-remoto"></a>

<details>
<summary>¿Cómo ejecuto trabajos en un clúster HPC remoto?</summary>

R: **Computación remota (SSH)** permanece siempre habilitada y no necesita activarse en Configuración. Registre un host de cálculo SSH en **Configuración → Cálculo**, hágalo disponible para la sesión actual y utilice lenguaje natural o `/remote-compute-ssh`. Se necesita un host SSH accesible, autenticación válida, permisos sobre los directorios necesarios y el software, las dependencias y los recursos de cálculo que requiera la tarea. Direct SSH no requiere planificador; el modo Slurm exige un entorno Slurm operativo y permiso para enviar trabajos. “Siempre habilitada” se refiere a la habilidad, no a la disponibilidad permanente de cada host registrado.

</details>

<a id="existe-una-interfaz-de-línea-de-comandos"></a>

<details>
<summary>¿Existe una interfaz de línea de comandos?</summary>

R: Sí. Instale la CLI independiente o use **Configuración → General → Herramienta de línea de comandos → Instalar comando** para controlar una instancia de escritorio que ya esté en ejecución. La instalación mediante npm requiere Node.js; Homebrew y los paquetes independientes con entorno de ejecución incluido ya lo incorporan. Inicialice el perfil local y, a continuación, controle el servicio y envíe tareas de investigación sin abrir un navegador:

```bash
# Inicie el servicio en segundo plano
open-science init
open-science start --no-open

# Cree un proyecto y ejecute una tarea usando su nombre exacto
open-science project create "Revisión sistemática"
open-science run --project "Revisión sistemática" \
  --prompt-file ./task.md \
  --approval-profile auto \
  --skill literature-review \
  --wait --json

# Descargue un artefacto generado
open-science artifacts list <session-id> --json
open-science artifacts download <artifact-id> --output ./report.md
```

Consulte la [guía CLI](../../packages/open-science/CLI.md) para obtener la referencia completa de comandos, formatos de salida JSON/JSONL, códigos de salida y opciones de servicio sin interfaz gráfica.

</details>

<a id="cómo-inspecciono-de-dónde-provino-un-resultado-generado"></a>

<details>
<summary>¿Cómo inspecciono de dónde provino un resultado generado?</summary>

R: Abra el artefacto generado y elija **Procedencia**. Seleccione una versión para inspeccionar la identidad del contenido, el código que produjo el artefacto, el historial de ejecución, las entradas, el inventario del entorno, el contexto de la conversación de origen y la evidencia del revisor. La evidencia que AIPOCH Open-Science no pudo verificar se marca como no disponible.

</details>

<a id="puedo-revisar-una-solicitud-anterior-sin-perder-la-conversación-que-siguió"></a>

<details>
<summary>¿Puedo revisar una solicitud anterior sin perder la conversación que siguió?</summary>

R: Sí. Edite un mensaje de usuario completo y reenvíelo para crear una nueva rama desde ese punto. Los turnos posteriores originales permanecen disponibles y las flechas de revisión junto al mensaje permiten cambiar entre las rutas alternativas.

</details>

## Colaboradores

Gracias a todas las personas que contribuyen a AIPOCH Open-Science con código, documentación, traducciones, informes de errores y ayuda a la comunidad.

[Ver colaboradores en GitHub](https://github.com/aipoch/open-science/graphs/contributors)

[![Colaboradores de AIPOCH Open-Science](https://contrib.rocks/image?repo=aipoch/open-science)](https://github.com/aipoch/open-science/graphs/contributors)

## Participe

Ayude a mejorar AIPOCH Open-Science: informe de un error, sugiera una función, haga una pregunta o contribuya. Elija un canal a continuación para empezar.

| Canal                                                                    | Úselo para                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [GitHub Problemas](https://github.com/aipoch/open-science/issues)        | Errores, fallos reproducibles y propuestas de funciones concretas                    |
| [GitHub Discusiones](https://github.com/aipoch/open-science/discussions) | Preguntas de diseño, propuestas de hoja de ruta y conversaciones técnicas más largas |
| [Discord](https://discord.gg/zxQAYjReRv)                                 | Ayuda comunitaria, coordinación de contribuyentes y discusión informal               |
| [X / @aipoch_ai](https://x.com/aipoch_ai)                                | Anuncios de versiones y novedades sobre el desarrollo público                        |
| [Sitio web de AIPOCH Open-Science](https://aipoch.com/open-science)      | Descripción general oficial del producto y descargas                                 |

Antes de abrir una incidencia pública, elimine de los registros y las capturas de pantalla las claves API, los tokens, las rutas de archivos privados, los datos no publicados, los identificadores de pacientes y cualquier otro material confidencial. Consulte [CONTRIBUTING.md](../../CONTRIBUTING.md) para conocer el flujo de trabajo de desarrollo.

> Si AIPOCH Open-Science le resulta útil, dé una estrella al repositorio en GitHub.

Las capacidades entregadas, parciales y previstas aparecen en el [mapa de capacidades](../ROADMAP.md#capability-map).

## Licencia

Licencia Apache 2.0: consulte [LICENSE](../../LICENSE).

## Historial de estrellas

<a href="https://star-history.dera.page/#aipoch/open-science&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
   <img alt="Gráfico del historial de estrellas de AIPOCH Open-Science en GitHub" src="https://star-history.dera.page/svg?repos=aipoch/open-science&type=date&legend=top-left" />
 </picture>
</a>
