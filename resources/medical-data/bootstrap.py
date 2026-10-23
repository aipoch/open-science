"""Start the bundled engine without installing packages or modifying a runtime."""
import importlib.util
from pathlib import Path
import runpy
import sys

modules = ['mcp', 'duckdb', 'pandas', 'httpx', 'pyreadstat']
missing = [name for name in modules if importlib.util.find_spec(name) is None]
if missing:
    print('Medical data engine: missing Python packages: ' + ', '.join(missing) +
          '. Use the application package manager to add the packages in the bundled requirements.txt to this Python runtime. No packages were installed automatically.', file=sys.stderr)
    sys.exit(1)
runpy.run_path(str(Path(__file__).with_name('server.py')), run_name='__main__')
