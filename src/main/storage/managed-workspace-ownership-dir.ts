// Name of the directory holding managed-workspace ownership records. Kept in its own electron-free
// module so pure-Node consumers (the storage usage scanner behind the artifact MCP server) can
// reference it without importing the electron-bound ownership reader.
export const MANAGED_WORKSPACE_OWNERSHIP_DIR = '.ownership'
