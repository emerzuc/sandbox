# Notas para sessões do Claude Code

## Skills CLI (`npx skills`) em sessões de nuvem

O `fetch` nativo do Node ignora `HTTPS_PROXY`, então o CLI não alcança `skills.sh`
e responde "No skills found" para qualquer termo, sem mostrar erro. Rode os
comandos que consultam o catálogo com `NODE_USE_ENV_PROXY=1`:

```bash
NODE_USE_ENV_PROXY=1 npx skills find <termo>
```

Isso vale para a skill `find-skills`, cujo `SKILL.md` não inclui o prefixo.

O host `skills.sh` precisa estar liberado na rede do ambiente (está no ambiente
"sandbox"). Instale skills no projeto (sem `-g`) e faça commit: a instalação em
nível de usuário se perde quando o container é reciclado.
