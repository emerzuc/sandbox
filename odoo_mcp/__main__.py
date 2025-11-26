"""Entry point for running as module: python -m odoo_mcp"""

import asyncio
import sys
from .server import main

if __name__ == "__main__":
    config_path = sys.argv[1] if len(sys.argv) > 1 else "odoo.cfg"
    asyncio.run(main(config_path))
