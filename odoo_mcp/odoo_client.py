"""Odoo client wrapper with connection management."""

from typing import Any
import odoorpc
from loguru import logger

from .config import OdooConfig


class OdooClient:
    """
    Wrapper around OdooRPC with connection pooling and error handling.

    Maintains authenticated session - no need to authenticate per operation.
    """

    def __init__(self, config: OdooConfig):
        """
        Initialize Odoo client.

        Args:
            config: Odoo connection configuration
        """
        self.config = config
        self._odoo: odoorpc.ODOO | None = None

    def connect(self) -> None:
        """Establish connection and authenticate."""
        try:
            logger.info(f"Connecting to {self.config.url}:{self.config.port}")

            self._odoo = odoorpc.ODOO(
                self.config.url,
                port=self.config.port,
                protocol=self.config.protocol,
                timeout=30
            )

            self._odoo.login(
                self.config.db,
                self.config.username,
                self.config.password
            )

            logger.success(
                f"Connected to Odoo {self._odoo.version} as {self.config.username}"
            )

        except Exception as e:
            logger.error(f"Failed to connect to Odoo: {e}")
            raise ConnectionError(f"Odoo connection failed: {e}") from e

    @property
    def odoo(self) -> odoorpc.ODOO:
        """Get authenticated Odoo instance."""
        if self._odoo is None:
            self.connect()
        return self._odoo

    def search_read(
        self,
        model: str,
        domain: list[Any],
        fields: list[str],
        limit: int = 50,
        offset: int = 0
    ) -> list[dict[str, Any]]:
        """
        Search and read records.

        Args:
            model: Odoo model name
            domain: Search domain
            fields: Fields to retrieve
            limit: Max records
            offset: Skip records

        Returns:
            List of record dictionaries
        """
        try:
            result = self.odoo.env[model].search_read(
                domain or [],
                fields or None,
                limit=limit,
                offset=offset
            )
            logger.debug(f"search_read {model}: {len(result)} records")
            return result

        except odoorpc.error.RPCError as e:
            logger.error(f"search_read failed on {model}: {e}")
            raise

    def create(self, model: str, values: dict[str, Any]) -> int:
        """
        Create a new record.

        Args:
            model: Odoo model name
            values: Field values

        Returns:
            ID of created record
        """
        try:
            record_id = self.odoo.env[model].create(values)
            logger.info(f"Created {model} id={record_id}")
            return record_id

        except odoorpc.error.RPCError as e:
            logger.error(f"create failed on {model}: {e}")
            raise

    def write(self, model: str, ids: list[int], values: dict[str, Any]) -> bool:
        """
        Update existing records.

        Args:
            model: Odoo model name
            ids: Record IDs to update
            values: Field values to update

        Returns:
            True if successful
        """
        try:
            result = self.odoo.env[model].write(ids, values)
            logger.info(f"Updated {model} ids={ids}")
            return result

        except odoorpc.error.RPCError as e:
            logger.error(f"write failed on {model}: {e}")
            raise

    def unlink(self, model: str, ids: list[int]) -> bool:
        """
        Delete records.

        Args:
            model: Odoo model name
            ids: Record IDs to delete

        Returns:
            True if successful
        """
        try:
            result = self.odoo.env[model].unlink(ids)
            logger.info(f"Deleted {model} ids={ids}")
            return result

        except odoorpc.error.RPCError as e:
            logger.error(f"unlink failed on {model}: {e}")
            raise

    def search(
        self,
        model: str,
        domain: list[Any],
        limit: int = 50,
        offset: int = 0
    ) -> list[int]:
        """
        Search for record IDs only.

        Args:
            model: Odoo model name
            domain: Search domain
            limit: Max records
            offset: Skip records

        Returns:
            List of record IDs
        """
        try:
            result = self.odoo.env[model].search(
                domain or [],
                limit=limit,
                offset=offset
            )
            logger.debug(f"search {model}: {len(result)} IDs")
            return result

        except odoorpc.error.RPCError as e:
            logger.error(f"search failed on {model}: {e}")
            raise

    def fields_get(
        self,
        model: str,
        fields: list[str] | None = None
    ) -> dict[str, Any]:
        """
        Get field metadata for a model.

        Args:
            model: Odoo model name
            fields: Specific fields (None = all)

        Returns:
            Dictionary of field definitions
        """
        try:
            result = self.odoo.env[model].fields_get(allfields=fields or [])
            logger.debug(f"fields_get {model}: {len(result)} fields")
            return result

        except odoorpc.error.RPCError as e:
            logger.error(f"fields_get failed on {model}: {e}")
            raise

    def list_models(self, name_filter: str = "") -> list[dict[str, Any]]:
        """
        List available models.

        Args:
            name_filter: Filter by model name (case-insensitive)

        Returns:
            List of model info dictionaries
        """
        try:
            # Search in ir.model
            domain = []
            if name_filter:
                domain = [("model", "ilike", name_filter)]

            models = self.odoo.env["ir.model"].search_read(
                domain,
                ["model", "name", "info"],
                limit=1000
            )

            logger.debug(f"list_models: {len(models)} models")
            return models

        except odoorpc.error.RPCError as e:
            logger.error(f"list_models failed: {e}")
            raise
