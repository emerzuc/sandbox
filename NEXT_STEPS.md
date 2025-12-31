# Próximos Passos - Google TV Home

## ✅ Já Feito

- [x] Arquitetura técnica completa documentada
- [x] Estrutura do projeto Android configurada
- [x] Dependências Gradle (Room, Retrofit, Compose TV, Hilt)
- [x] Modelos de domínio (Content, SportsMatch)
- [x] DeepLinkHelper com suporte a múltiplos apps
- [x] Tema e tipografia otimizados para TV
- [x] MainActivity com Compose básico

## 🔄 Próximos Passos Imediatos

### 1. Obter API Keys (IMPORTANTE!)

Antes de começar, você precisa criar contas e obter chaves:

#### TMDB API (Filmes/Séries) - GRATUITA
1. Acesse: https://www.themoviedb.org/signup
2. Crie uma conta
3. Vá em: Configurações → API → Criar
4. Copie a "API Key (v3 auth)"
5. Cole em `local.properties`: `TMDB_API_KEY=sua_chave`

#### Gemini API (Chat IA) - GRATUITA
1. Acesse: https://makersuite.google.com/app/apikey
2. Faça login com Google
3. Clique em "Create API Key"
4. Cole em `local.properties`: `GEMINI_API_KEY=sua_chave`

#### API-Football (Futebol) - FREEMIUM
1. Acesse: https://www.api-football.com/
2. Crie conta (100 requests/dia grátis)
3. Copie sua API key do dashboard
4. Cole em `local.properties`: `FOOTBALL_API_KEY=sua_chave`

**ALTERNATIVA GRATUITA para Futebol:**
- TheSportsDB: https://www.thesportsdb.com/api.php (totalmente grátis, menos completa)

### 2. Configurar Projeto no Android Studio

```bash
# 1. Copiar arquivo de exemplo
cp local.properties.example local.properties

# 2. Editar local.properties e adicionar suas API keys
nano local.properties

# 3. Abrir projeto no Android Studio
# File → Open → Selecionar pasta do projeto

# 4. Aguardar Gradle Sync

# 5. Criar emulador Google TV
# Tools → Device Manager → Create Device → TV → Google TV (1080p)
```

### 3. Implementar Database (Room)

**Arquivos a criar:**
- `data/local/entities/ContentEntity.kt`
- `data/local/entities/SeriesProgressEntity.kt`
- `data/local/entities/ViewingHistoryEntity.kt`
- `data/local/entities/SportsMatchEntity.kt`
- `data/local/dao/ContentDao.kt`
- `data/local/dao/SportsDao.kt`
- `data/local/AppDatabase.kt`

**Ver exemplos em:** `ARCHITECTURE.md` seção "Banco de Dados (Room)"

### 4. Implementar APIs (Retrofit)

**TMDB API:**
- `data/remote/tmdb/TmdbApi.kt` (interface Retrofit)
- `data/remote/tmdb/dto/` (data transfer objects)
- `data/remote/tmdb/TmdbService.kt` (wrapper)

**Sports API:**
- `data/remote/sports/FootballApi.kt`
- `data/remote/sports/NbaApi.kt`

**Gemini API:**
- `data/remote/gemini/GeminiApi.kt`
- `data/remote/gemini/GeminiService.kt`

### 5. Implementar Repositories

- `data/repository/ContentRepository.kt`
- `data/repository/SportsRepository.kt`
- `data/repository/ChatRepository.kt`

**Padrão:** Repository combina dados locais (Room) + remotos (API)

### 6. Implementar ViewModels e UI

**Home Screen:**
- `presentation/home/HomeViewModel.kt`
- `presentation/home/HomeScreen.kt`
- `presentation/home/components/SportsSection.kt`
- `presentation/home/components/WatchlistCarousel.kt`

**Detail Screen:**
- `presentation/detail/DetailViewModel.kt`
- `presentation/detail/DetailScreen.kt`

### 7. Configurar Navegação

- `presentation/navigation/NavGraph.kt`
- Integrar Navigation Compose

### 8. Testar no Emulador

```bash
# Rodar app
./gradlew installDebug

# Ou via Android Studio: Run → Run 'app'
```

## 📝 Desenvolvimento Recomendado (Ordem)

### MVP 1 - Core Básico (Semana 1-2)
1. ✅ Setup database Room
2. ✅ Integração TMDB API
3. ✅ Tela Home básica (lista de filmes)
4. ✅ Tela de detalhes
5. ✅ Watchlist funcional
6. ✅ Deep link para Netflix/Prime

### MVP 2 - Esportes (Semana 3)
1. ✅ Integração API Football
2. ✅ Seção "Jogos Hoje" na Home
3. ✅ Mapeamento de canais Brasil
4. ✅ Deep links ESPN/Globoplay

### MVP 3 - Chat IA (Semana 4)
1. ✅ Integração Gemini
2. ✅ Interface de chat
3. ✅ Contexto baseado em histórico

### MVP 4 - Polish (Semana 5)
1. ✅ Histórico completo
2. ✅ Estatísticas
3. ✅ Melhorias de UX
4. ✅ Otimizações de performance

## 🐛 Possíveis Problemas e Soluções

### "SDK location not found"
**Solução:** Adicione em `local.properties`:
```
sdk.dir=/Users/SEU_USUARIO/Library/Android/sdk  # macOS
sdk.dir=/home/SEU_USUARIO/Android/Sdk            # Linux
sdk.dir=C\:\\Users\\SEU_USUARIO\\AppData\\Local\\Android\\Sdk  # Windows
```

### "Unresolved reference: BuildConfig"
**Solução:** Rebuild project (`Build → Rebuild Project`)

### Deep links não funcionam
**Solução:**
- Verificar se app está instalado
- Testar intent via ADB:
```bash
adb shell am start -a android.intent.action.VIEW -d "netflix://title/123456"
```

### API retorna 401 (Unauthorized)
**Solução:** Verificar se API key está correta em `local.properties`

## 📚 Recursos Úteis

- **TMDB API Docs:** https://developers.themoviedb.org/3
- **Jetpack Compose TV:** https://developer.android.com/training/tv/playback/compose
- **Android TV Input Guide:** https://developer.android.com/training/tv/start/navigation
- **Gemini API Docs:** https://ai.google.dev/docs

## 🎯 Dicas de Desenvolvimento

1. **Use o emulador com controle D-pad** (WASD no teclado)
2. **Teste foco de navegação** - todo elemento clicável deve ser focável
3. **Fontes grandes** - lembre que TV é visualizada de longe
4. **Lazy loading** - carregue imagens sob demanda (Coil faz isso)
5. **Cache** - TMDB permite cache, use Room para offline

## 💡 Ideias Futuras (Pós-MVP)

- [ ] Sincronização cloud (Firebase)
- [ ] Widget de "Próximos Jogos"
- [ ] Notificações de jogos favoritos
- [ ] Integração com Trakt.tv
- [ ] Suporte a múltiplos perfis
- [ ] Modo offline completo
- [ ] Recomendações colaborativas
- [ ] Integração com calendário

---

**Pronto para começar?** Siga a ordem acima e veja `ARCHITECTURE.md` para detalhes técnicos!
