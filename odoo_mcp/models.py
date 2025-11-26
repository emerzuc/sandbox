"""Pydantic models for Odoo MCP server request validation."""

from typing import Any, Literal
from pydantic import BaseModel, Field, field_validator


OdooOperator = Literal[
    "=", "!=", ">", ">=", "<", "<=",
    "like", "ilike", "not like", "not ilike",
    "in", "not in",
    "child_of", "parent_of",
    "=like", "=ilike"
]


class SearchReadParams(BaseModel):
    """Parameters for search_read operation."""
    model: str = Field(..., description="Odoo model name (e.g., 'res.partner')")
    domain: list[Any] = Field(
        default_factory=list,
        description="Odoo domain filter in Polish notation"
    )
    fields: list[str] = Field(
        default_factory=list,
        description="Fields to retrieve (empty = all)"
    )
    limit: int = Field(default=50, ge=1, le=1000, description="Maximum records to return")
    offset: int = Field(default=0, ge=0, description="Number of records to skip")

    @field_validator('domain')
    @classmethod
    def validate_domain(cls, v: list[Any]) -> list[Any]:
        """Validate basic domain structure (tuples of 3 elements or logical operators)."""
        if not v:
            return v

        for item in v:
            if isinstance(item, str) and item in ('&', '|', '!'):
                continue
            if isinstance(item, (list, tuple)):
                if len(item) != 3:
                    raise ValueError(f"Domain tuple must have 3 elements: {item}")
                field, operator, value = item
                if not isinstance(field, str):
                    raise ValueError(f"Domain field must be string: {field}")
            else:
                raise ValueError(f"Domain item must be tuple or operator: {item}")

        return v


class CreateParams(BaseModel):
    """Parameters for create operation."""
    model: str = Field(..., description="Odoo model name")
    values: dict[str, Any] = Field(..., description="Field values for new record")


class WriteParams(BaseModel):
    """Parameters for write/update operation."""
    model: str = Field(..., description="Odoo model name")
    ids: list[int] | int = Field(..., description="Record ID(s) to update")
    values: dict[str, Any] = Field(..., description="Field values to update")

    @field_validator('ids')
    @classmethod
    def normalize_ids(cls, v: list[int] | int) -> list[int]:
        """Normalize single ID to list."""
        return [v] if isinstance(v, int) else v


class UnlinkParams(BaseModel):
    """Parameters for unlink/delete operation."""
    model: str = Field(..., description="Odoo model name")
    ids: list[int] | int = Field(..., description="Record ID(s) to delete")

    @field_validator('ids')
    @classmethod
    def normalize_ids(cls, v: list[int] | int) -> list[int]:
        """Normalize single ID to list."""
        return [v] if isinstance(v, int) else v


class SearchParams(BaseModel):
    """Parameters for search operation (returns IDs only)."""
    model: str = Field(..., description="Odoo model name")
    domain: list[Any] = Field(
        default_factory=list,
        description="Odoo domain filter"
    )
    limit: int = Field(default=50, ge=1, le=1000)
    offset: int = Field(default=0, ge=0)


class FieldsGetParams(BaseModel):
    """Parameters for fields_get operation."""
    model: str = Field(..., description="Odoo model name")
    fields: list[str] = Field(
        default_factory=list,
        description="Specific fields to get metadata for (empty = all)"
    )


class ListModelsParams(BaseModel):
    """Parameters for list_models operation."""
    name_filter: str = Field(
        default="",
        description="Filter models by name (case-insensitive substring match)"
    )
