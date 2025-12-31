# Google TV Home Personalizada 📺

Hub de entretenimento personalizado para Google TV que agrega conteúdo de múltiplas plataformas (streaming, esportes) com recomendações por IA.

## ✨ Funcionalidades

- 🏠 **Home personalizada** com acesso rápido a todo conteúdo
- 🎬 **Filmes & Séries** com watchlist e tracking
- ⚽ **Esportes** (Futebol + NBA) com programação do dia
- 💬 **Chat IA** para recomendações personalizadas
- 📅 **Histórico** de tudo que você assistiu
- 🔗 **Deep links** diretos para apps (Netflix, Prime, Stremio, etc.)

## 🛠️ Tecnologias

- **Kotlin** + **Jetpack Compose for TV**
- **Room** (banco de dados local)
- **Retrofit** (networking)
- **TMDB API** (filmes/séries)
- **API-Football** (futebol)
- **Gemini API** (chat IA)

## 📖 Documentação

Veja [ARCHITECTURE.md](./ARCHITECTURE.md) para detalhes técnicos completos.

## 🚀 Como Rodar

### Pré-requisitos
- Android Studio Hedgehog ou superior
- JDK 17+
- Google TV emulador ou dispositivo físico

### Setup
1. Clone o repositório
```bash
git clone <repo-url>
cd sandbox
```

2. Crie `local.properties` na raiz do projeto com suas API keys:
```properties
TMDB_API_KEY=sua_chave_tmdb
GEMINI_API_KEY=sua_chave_gemini
FOOTBALL_API_KEY=sua_chave_football
```

3. Abra no Android Studio e sincronize o Gradle

4. Execute no emulador Google TV ou dispositivo físico

## 🎯 Roadmap

- [x] Planejamento e arquitetura
- [ ] MVP 1: Filmes/Séries básico
- [ ] MVP 2: Esportes
- [ ] MVP 3: Chat IA
- [ ] MVP 4: Histórico & polish

## 📝 Licença

MIT
