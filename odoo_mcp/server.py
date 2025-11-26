"""MCP server exposing Odoo operations as tools."""

import sys
from typing import Any
from loguru import logger
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent
from pydantic import ValidationError
import odoorpc.error

from .config import load_config
from .odoo_client import OdooClient
from .models import (
    SearchReadParams,
    CreateParams,
    WriteParams,
    UnlinkParams,
    SearchParams,
    FieldsGetParams,
    ListModelsParams,
)


# Configure logging
logger.remove()
logger.add(
    sys.stderr,
    level="INFO",
    format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <level>{message}</level>"
)


class OdooMCPServer:
    """MCP Server for Odoo operations."""

    def __init__(self, config_path: str = "odoo.cfg"):
        """Initialize server with Odoo connection."""
        self.server = Server("odoo-mcp-server")
        self.config = load_config(config_path)
        self.client = OdooClient(self.config)

        # Register tools
        self._register_tools()

    def _register_tools(self) -> None:
        """Register all MCP tools."""

        @self.server.list_tools()
        async def list_tools() -> list[Tool]:
            """List available tools."""
            return [
                Tool(
                    name="odoo_search_read",
                    description="Search and read Odoo records with filters. Returns full record data.",
                    inputSchema=SearchReadParams.model_json_schema()
                ),
                Tool(
                    name="odoo_create",
                    description="Create a new Odoo record. Returns the ID of created record.",
                    inputSchema=CreateParams.model_json_schema()
                ),
                Tool(
                    name="odoo_write",
                    description="Update existing Odoo record(s). Returns success status.",
                    inputSchema=WriteParams.model_json_schema()
                ),
                Tool(
                    name="odoo_unlink",
                    description="Delete Odoo record(s). Returns success status.",
                    inputSchema=UnlinkParams.model_json_schema()
                ),
                Tool(
                    name="odoo_search",
                    description="Search for Odoo record IDs matching criteria. Returns only IDs.",
                    inputSchema=SearchParams.model_json_schema()
                ),
                Tool(
                    name="odoo_fields_get",
                    description="Get field metadata/schema for an Odoo model.",
                    inputSchema=FieldsGetParams.model_json_schema()
                ),
                Tool(
                    name="odoo_list_models",
                    description="List available Odoo models with optional name filter.",
                    inputSchema=ListModelsParams.model_json_schema()
                ),
            ]

        @self.server.call_tool()
        async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
            """Handle tool calls."""
            try:
                logger.info(f"Tool call: {name} with {arguments}")

                if name == "odoo_search_read":
                    return await self._search_read(arguments)
                elif name == "odoo_create":
                    return await self._create(arguments)
                elif name == "odoo_write":
                    return await self._write(arguments)
                elif name == "odoo_unlink":
                    return await self._unlink(arguments)
                elif name == "odoo_search":
                    return await self._search(arguments)
                elif name == "odoo_fields_get":
                    return await self._fields_get(arguments)
                elif name == "odoo_list_models":
                    return await self._list_models(arguments)
                else:
                    raise ValueError(f"Unknown tool: {name}")

            except ValidationError as e:
                error_msg = f"Validation error: {e}"
                logger.error(error_msg)
                return [TextContent(type="text", text=error_msg)]

            except odoorpc.error.RPCError as e:
                error_msg = f"Odoo RPC error: {e}"
                logger.error(error_msg)
                return [TextContent(type="text", text=error_msg)]

            except Exception as e:
                error_msg = f"Unexpected error: {type(e).__name__}: {e}"
                logger.exception(error_msg)
                return [TextContent(type="text", text=error_msg)]

    async def _search_read(self, arguments: dict[str, Any]) -> list[TextContent]:
        """Execute search_read operation."""
        params = SearchReadParams.model_validate(arguments)

        result = self.client.search_read(
            model=params.model,
            domain=params.domain,
            fields=params.fields,
            limit=params.limit,
            offset=params.offset
        )

        return [TextContent(
            type="text",
            text=f"Found {len(result)} records:\n{result}"
        )]

    async def _create(self, arguments: dict[str, Any]) -> list[TextContent]:
        """Execute create operation."""
        params = CreateParams.model_validate(arguments)

        record_id = self.client.create(
            model=params.model,
            values=params.values
        )

        return [TextContent(
            type="text",
            text=f"Created record with ID: {record_id}"
        )]

    async def _write(self, arguments: dict[str, Any]) -> list[TextContent]:
        """Execute write operation."""
        params = WriteParams.model_validate(arguments)

        success = self.client.write(
            model=params.model,
            ids=params.ids,
            values=params.values
        )

        return [TextContent(
            type="text",
            text=f"Updated {len(params.ids)} record(s): {success}"
        )]

    async def _unlink(self, arguments: dict[str, Any]) -> list[TextContent]:
        """Execute unlink operation."""
        params = UnlinkParams.model_validate(arguments)

        success = self.client.unlink(
            model=params.model,
            ids=params.ids
        )

        return [TextContent(
            type="text",
            text=f"Deleted {len(params.ids)} record(s): {success}"
        )]

    async def _search(self, arguments: dict[str, Any]) -> list[TextContent]:
        """Execute search operation."""
        params = SearchParams.model_validate(arguments)

        ids = self.client.search(
            model=params.model,
            domain=params.domain,
            limit=params.limit,
            offset=params.offset
        )

        return [TextContent(
            type="text",
            text=f"Found {len(ids)} IDs: {ids}"
        )]

    async def _fields_get(self, arguments: dict[str, Any]) -> list[TextContent]:
        """Execute fields_get operation."""
        params = FieldsGetParams.model_validate(arguments)

        fields = self.client.fields_get(
            model=params.model,
            fields=params.fields if params.fields else None
        )

        return [TextContent(
            type="text",
            text=f"Fields for {params.model}:\n{fields}"
        )]

    async def _list_models(self, arguments: dict[str, Any]) -> list[TextContent]:
        """Execute list_models operation."""
        params = ListModelsParams.model_validate(arguments)

        models = self.client.list_models(name_filter=params.name_filter)

        model_list = "\n".join(
            f"- {m['model']}: {m['name']}" for m in models
        )

        return [TextContent(
            type="text",
            text=f"Found {len(models)} models:\n{model_list}"
        )]

    async def run(self) -> None:
        """Run the MCP server."""
        logger.info("Starting Odoo MCP Server...")

        # Initialize connection
        self.client.connect()

        # Run stdio server
        async with stdio_server() as (read_stream, write_stream):
            logger.success("Server running on stdio")
            await self.server.run(
                read_stream,
                write_stream,
                self.server.create_initialization_options()
            )


async def main(config_path: str = "odoo.cfg") -> None:
    """Main entry point."""
    server = OdooMCPServer(config_path)
    await server.run()


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
