"""Odoo MCP Server - Expose Odoo operations via Model Context Protocol."""

__version__ = "0.1.0"

from .server import OdooMCPServer, main
from .odoo_client import OdooClient
from .config import OdooConfig, load_config

__all__ = ["OdooMCPServer", "main", "OdooClient", "OdooConfig", "load_config"]
