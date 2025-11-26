"""Configuration loader for Odoo connection."""

import configparser
from pathlib import Path
from pydantic import BaseModel, Field
from loguru import logger


class OdooConfig(BaseModel):
    """Odoo connection configuration."""
    url: str = Field(..., description="Odoo server URL")
    port: int = Field(default=8069, description="Odoo XML-RPC port")
    db: str = Field(..., description="Database name")
    username: str = Field(..., description="Odoo username")
    password: str = Field(..., description="Odoo password")
    protocol: str = Field(default="jsonrpc+ssl", description="Protocol (jsonrpc or jsonrpc+ssl)")


def load_config(config_path: str | Path = "odoo.cfg") -> OdooConfig:
    """
    Load Odoo configuration from .cfg file.

    Args:
        config_path: Path to configuration file

    Returns:
        OdooConfig instance

    Raises:
        FileNotFoundError: If config file doesn't exist
        ValueError: If required fields are missing
    """
    config_path = Path(config_path)

    if not config_path.exists():
        raise FileNotFoundError(
            f"Config file not found: {config_path}\n"
            f"Create it from odoo.cfg.example"
        )

    parser = configparser.ConfigParser()
    parser.read(config_path)

    if "odoo" not in parser:
        raise ValueError("Config file must have [odoo] section")

    odoo_section = parser["odoo"]

    try:
        config = OdooConfig(
            url=odoo_section["url"],
            port=int(odoo_section.get("port", "8069")),
            db=odoo_section["database"],
            username=odoo_section["username"],
            password=odoo_section["password"],
            protocol=odoo_section.get("protocol", "jsonrpc+ssl")
        )
        logger.info(f"Loaded config: {config.url}:{config.port} db={config.db} user={config.username}")
        return config

    except KeyError as e:
        raise ValueError(f"Missing required config field: {e}")
