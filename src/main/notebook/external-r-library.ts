import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'

/** Resolve consent to one existing physical directory; never create/adopt a user library. */
export const resolveExternalRLibrary = async (library: string): Promise<string> => {
  if (typeof library !== 'string' || !isAbsolute(library) || library.includes('\0'))
    throw new Error('Select an existing absolute R package library path.')
  const physical = await realpath(library)
  if (!(await stat(physical)).isDirectory())
    throw new Error('R package library is not a directory.')
  await access(physical, constants.R_OK | constants.W_OK)
  return physical
}

/** Same interpreter/profile context as execution; refuse a different or system library. */
export const externalRInstallScript = (
  library: string,
  packages: readonly string[],
  repository: string
): string => `local({
  destination <- normalizePath(${JSON.stringify(library)}, winslash="/", mustWork=TRUE)
  normalize <- function(paths) normalizePath(paths, winslash="/", mustWork=FALSE)
  same <- function(paths) if (.Platform$OS.type == "windows") tolower(paths) else paths
  if (!(same(destination) %in% same(normalize(.libPaths()))) ||
      same(destination) %in% same(normalize(c(.Library, .Library.site))))
    stop("The authorized library must be a personal library visible to this R runtime.")
  if (file.access(destination, 2) != 0) stop("The authorized R library is not writable.")
  packages <- c(${packages.map((name) => JSON.stringify(name)).join(',')})
  options(warn=2)
  utils::install.packages(packages, lib=destination, repos=${JSON.stringify(repository)})
  installed <- utils::installed.packages(lib.loc=destination)
  if (!all(packages %in% installed[, "Package"])) stop("R package installation is incomplete.")
})`
