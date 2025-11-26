# Odoo MCP Server

Model Context Protocol (MCP) server that exposes Odoo operations via XML-RPC.

## Arquitetura

```
odoo_mcp/
├── models.py        # Pydantic schemas com validação robusta
├── config.py        # Loader de configuração .cfg
├── odoo_client.py   # Wrapper odoorpc com session caching
└── server.py        # MCP server com 7 tools
```

### Stack

- **odoorpc**: Cliente Python nativo para Odoo (mantém sessão autenticada)
- **mcp**: SDK oficial do Model Context Protocol
- **pydantic v2**: Validação de schemas com type safety
- **loguru**: Logging estruturado

## Features

✅ **Session caching**: Autenticação única (não repete a cada operação)
✅ **Validação robusta**: Pydantic valida domains, IDs, fields
✅ **Error handling**: Try-catch em todas as tools com mensagens claras
✅ **Logging estruturado**: Loguru com níveis INFO/DEBUG/ERROR
✅ **Type safety**: Hints completos + validação runtime

## Tools Disponíveis

### 1. `odoo_search_read`
Busca e retorna dados completos de registros.

**Exemplo:**
```json
{
  "model": "res.partner",
  "domain": [["is_company", "=", true]],
  "fields": ["name", "email", "phone"],
  "limit": 50,
  "offset": 0
}
```

### 2. `odoo_create`
Cria novo registro.

**Exemplo:**
```json
{
  "model": "res.partner",
  "values": {
    "name": "Empresa Teste",
    "email": "contato@empresa.com",
    "is_company": true
  }
}
```

### 3. `odoo_write`
Atualiza registro(s) existente(s).

**Exemplo:**
```json
{
  "model": "res.partner",
  "ids": [123, 456],
  "values": {"phone": "+55 11 99999-9999"}
}
```

### 4. `odoo_unlink`
Deleta registro(s).

**Exemplo:**
```json
{
  "model": "res.partner",
  "ids": [789]
}
```

### 5. `odoo_search`
Retorna apenas IDs (sem dados completos).

**Exemplo:**
```json
{
  "model": "sale.order",
  "domain": [["state", "=", "draft"]],
  "limit": 100
}
```

### 6. `odoo_fields_get`
Retorna metadados dos campos de um modelo (schema).

**Exemplo:**
```json
{
  "model": "res.partner",
  "fields": ["name", "email"]
}
```

### 7. `odoo_list_models`
Lista modelos disponíveis no Odoo.

**Exemplo:**
```json
{
  "name_filter": "sale"
}
```

## Instalação

### Requisitos
- Python 3.10+
- Poetry ou pip

### Setup

```bash
# Clone o repositório
git clone <repo-url>
cd odoo-mcp-server

# Instale dependências com Poetry
poetry install

# Ou com pip
pip install -e .

# Copie e configure odoo.cfg
cp odoo.cfg.example odoo.cfg
nano odoo.cfg  # Edite com suas credenciais
```

### Configuração (`odoo.cfg`)

```ini
[odoo]
url = your-odoo-server.com
port = 8069
protocol = jsonrpc+ssl  # ou jsonrpc para HTTP
database = production_db
username = admin
password = strong_password
```

## Uso

### Modo stdio (padrão MCP)

```bash
# Com Poetry
poetry run python -m odoo_mcp

# Ou diretamente
python -m odoo_mcp odoo.cfg
```

### Integração com Claude Desktop

Adicione ao config do Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "odoo": {
      "command": "python",
      "args": ["-m", "odoo_mcp", "/caminho/para/odoo.cfg"]
    }
  }
}
```

## Desenvolvimento

### Testes

```bash
poetry run pytest
```

### Linting

```bash
poetry run ruff check .
poetry run black --check .
```

### Formatar

```bash
poetry run black .
```

## Melhorias vs Node.js

| Aspecto | Node.js (anterior) | Python (atual) |
|---------|-------------------|----------------|
| **Autenticação** | Repetida a cada call | Cached na sessão (odoorpc) |
| **Validação** | `z.any()` fraco | Pydantic v2 com schemas reais |
| **Error handling** | Ausente | Try-catch em todas tools |
| **Type safety** | Limitado | Full typing + runtime validation |
| **Logging** | Console.log básico | Loguru estruturado |
| **Timeout** | Sem timeout | 30s default no odoorpc |
| **Limite padrão** | Inconsistente (50 vs 80) | Padronizado em 50 |

## Troubleshooting

### Erro: "Config file not found"
```bash
cp odoo.cfg.example odoo.cfg
# Edite odoo.cfg com suas credenciais
```

### Erro: "Odoo connection failed"
- Verifique URL/porta/protocolo no `odoo.cfg`
- Teste conexão: `curl https://your-odoo-server.com`
- Verifique firewall/VPN

### Erro: "Access Denied"
- Confirme username/password corretos
- Verifique permissões do usuário no Odoo

## Licença

MIT
