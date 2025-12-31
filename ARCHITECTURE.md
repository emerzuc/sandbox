# Arquitetura Técnica - Google TV Home Personalizada

## 📋 Visão Geral

App Android nativo para Google TV que agrega conteúdo de múltiplas plataformas (streaming, esportes) em uma interface personalizada com recomendações por IA.

## 🎯 Funcionalidades Core

### 1. Home Personalizada
- Dashboard unificado com acesso rápido a todo conteúdo
- Seções: Jogos Hoje, Continuar Assistindo, Quero Assistir, Histórico
- Navegação otimizada para D-pad/controle remoto

### 2. Filmes & Séries
- Busca integrada com TMDB
- Watchlist ("Quero Assistir")
- Tracking de séries em andamento (episódios assistidos)
- Ratings e metadados (TMDB/IMDB)
- "Onde Assistir" com detecção de apps instalados
- Deep links diretos para streamings (Netflix, Prime, Stremio, etc.)

### 3. Esportes (Futebol + NBA)
- Jogos do dia com horário e canal/streaming
- Programação específica para Brasil:
  - **NBA:** ESPN, Prime Video, Disney+, YouTube NBA Brasil
  - **Futebol:** Globo, SporTV, Premiere, Prime Video
- Deep links para assistir direto

### 4. Chat de Recomendações (IA)
- Assistente integrado com Gemini API
- Sugestões baseadas em histórico pessoal
- Contexto: preferências, ratings, watchlist

### 5. Histórico de Visualização
- Log de tudo assistido (manual via "Já assisti")
- Navegação por data
- Estatísticas e insights

---

## 🏗️ Stack Tecnológico

### Linguagem & Framework
- **Kotlin** (nativo Android)
- **Jetpack Compose for TV** (UI declarativa, suporte oficial Google desde 2023)
- **Material Design 3** adaptado para TV
- **Leanback Library** (fallback se necessário)

### Arquitetura
- **MVVM** (Model-View-ViewModel)
- **Clean Architecture** (camadas: Data, Domain, Presentation)
- **Repository Pattern** (abstração de fontes de dados)

### Bibliotecas Principais

#### UI & Navegação
```gradle
androidx.tv:tv-foundation:1.0.0-alpha10
androidx.tv:tv-material:1.0.0-alpha10
androidx.compose.ui:ui
androidx.compose.material3:material3
androidx.navigation:navigation-compose
```

#### Banco de Dados Local
```gradle
androidx.room:room-runtime:2.6.1
androidx.room:room-ktx:2.6.1
```

#### Networking
```gradle
com.squareup.retrofit2:retrofit:2.9.0
com.squareup.retrofit2:converter-gson:2.9.0
com.squareup.okhttp3:logging-interceptor:4.12.0
```

#### Imagens
```gradle
io.coil-kt:coil-compose:2.5.0
```

#### Injeção de Dependência
```gradle
com.google.dagger:hilt-android:2.50
```

#### Coroutines & Flow
```gradle
org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3
```

---

## 🗄️ Banco de Dados (Room)

### Entidades

#### Content (Filmes/Séries)
```kotlin
@Entity(tableName = "content")
data class ContentEntity(
    @PrimaryKey val id: Int,
    val tmdbId: Int,
    val type: ContentType, // MOVIE, SERIES
    val title: String,
    val posterPath: String?,
    val backdropPath: String?,
    val overview: String,
    val rating: Double,
    val releaseDate: String,
    val genres: List<String>,
    val runtime: Int?,
    val status: ContentStatus, // WATCHLIST, WATCHING, COMPLETED
    val addedAt: Long,
    val lastWatchedAt: Long?
)
```

#### SeriesProgress
```kotlin
@Entity(tableName = "series_progress")
data class SeriesProgressEntity(
    @PrimaryKey(autoGenerate = true) val id: Int = 0,
    val contentId: Int, // FK to ContentEntity
    val seasonNumber: Int,
    val episodeNumber: Int,
    val watchedAt: Long
)
```

#### ViewingHistory
```kotlin
@Entity(tableName = "viewing_history")
data class ViewingHistoryEntity(
    @PrimaryKey(autoGenerate = true) val id: Int = 0,
    val contentId: Int,
    val watchedAt: Long,
    val platform: String? // "Netflix", "Prime Video", etc.
)
```

#### SportsMatch
```kotlin
@Entity(tableName = "sports_matches")
data class SportsMatchEntity(
    @PrimaryKey val id: String,
    val sport: SportType, // FOOTBALL, NBA
    val homeTeam: String,
    val awayTeam: String,
    val league: String,
    val matchDate: Long,
    val broadcastChannel: String?, // "Globo", "ESPN", "Premiere"
    val streamingPlatform: String?, // "Prime Video", "Disney+"
    val deepLink: String?
)
```

---

## 🌐 APIs e Integrações

### 1. TMDB API (The Movie Database)
**Base URL:** `https://api.themoviedb.org/3/`
**Chave:** Gratuita (criar em https://www.themoviedb.org/settings/api)

**Endpoints principais:**
- `GET /search/multi?query={query}` - Busca filmes/séries
- `GET /movie/{id}` - Detalhes do filme
- `GET /tv/{id}` - Detalhes da série
- `GET /movie/{id}/watch/providers?watch_region=BR` - Onde assistir no Brasil
- `GET /trending/all/day` - Tendências
- `GET /discover/movie` - Descobrir filmes por gênero/rating

**Response exemplo (Watch Providers):**
```json
{
  "results": {
    "BR": {
      "flatrate": [
        {"provider_id": 8, "provider_name": "Netflix"},
        {"provider_id": 119, "provider_name": "Amazon Prime Video"}
      ]
    }
  }
}
```

### 2. API-Football (Futebol)
**Base URL:** `https://v3.football.api-sports.io/`
**Chave:** Freemium (100 req/dia grátis)

**Endpoints:**
- `GET /fixtures?league=71&season=2025` - Jogos do Brasileirão
- `GET /fixtures?date=2025-12-31` - Jogos de hoje
- `GET /leagues?country=Brazil` - Ligas brasileiras

**Mapeamento de canais:**
Necessário mapear manualmente ou scraping de:
- Globo Esporte: https://ge.globo.com/futebol/
- Premiere programação

### 3. NBA API / TheSportsDB
**TheSportsDB:** `https://www.thesportsdb.com/api/v1/json/3/`
- `GET /eventsday.php?d={YYYY-MM-DD}&l=4387` - NBA games by date

**Mapeamento de canais Brasil:**
```kotlin
val nbaBroadcastMap = mapOf(
    "prime_games" to "Prime Video", // 147 jogos
    "monday_games" to "YouTube NBA Brasil", // Grátis
    "espn_games" to "ESPN/Disney+",
    "finals" to "Prime Video" // Exclusivo
)
```

### 4. Gemini API (Chat de Recomendações)
**Base URL:** `https://generativelanguage.googleapis.com/v1beta/`
**Chave:** Gratuita até 60 req/min

**Prompt template:**
```
Você é um assistente de recomendações de entretenimento.

Histórico do usuário:
- Filmes assistidos: {watched_movies}
- Séries assistindo: {current_series}
- Gêneros favoritos: {favorite_genres}

Usuário perguntou: "{user_query}"

Sugira 3-5 opções com justificativa curta.
```

---

## 📱 Deep Links e Detecção de Apps

### Detecção de Apps Instalados
```kotlin
fun getInstalledStreamingApps(context: Context): List<StreamingApp> {
    val packageManager = context.packageManager
    val streamingPackages = mapOf(
        "com.netflix.ninja" to "Netflix",
        "com.amazon.avod.thirdpartyclient" to "Prime Video",
        "com.disney.disneyplus" to "Disney+",
        "com.stremio.one" to "Stremio",
        "com.hbo.hbonow" to "HBO Max",
        "com.spotify.tv.android" to "Spotify"
    )

    return streamingPackages.mapNotNull { (pkg, name) ->
        try {
            packageManager.getPackageInfo(pkg, 0)
            StreamingApp(name, pkg)
        } catch (e: PackageManager.NameNotFoundException) {
            null
        }
    }
}
```

### Deep Links para Conteúdo

#### Netflix
```kotlin
// Por ID do título Netflix
"netflix://title/{netflix_id}"

// Fallback web
"https://www.netflix.com/watch/{netflix_id}"
```

#### Prime Video
```kotlin
"intent://www.amazon.com.br/gp/video/detail/{asin}#Intent;scheme=https;package=com.amazon.avod.thirdpartyclient;end"
```

#### Stremio
```kotlin
"stremio://detail/{type}/{imdb_id}"
// type: movie, series
```

**Estratégia:**
1. Detectar apps instalados
2. Priorizar app preferido do usuário
3. Botão principal "Assistir [Netflix]"
4. Botão secundário "Outras opções" (modal com todas)

---

## 🎨 UI/UX - Navegação TV

### Princípios de Design
- **Distância de visualização:** 3+ metros
- **Fontes grandes:** Título 24-32sp, corpo 18-20sp
- **Foco claro:** Indicador visual forte (borda/sombra)
- **Navegação D-pad:** Todas as ações acessíveis por setas + OK

### Tela Home (Compose TV)
```kotlin
@Composable
fun HomeScreen() {
    TvLazyColumn {
        item { SportsSection() } // Jogos hoje
        item { ChatSection() } // Chat IA
        item { ContinueWatchingRow() } // Carrossel horizontal
        item { WatchlistRow() }
        item { HistorySection() }
    }
}

@Composable
fun SportsSection() {
    Card(modifier = Modifier.focusable()) {
        Column {
            Text("⚽ Jogos Hoje", style = MaterialTheme.typography.headlineMedium)
            matches.forEach { match ->
                MatchCard(
                    homeTeam = match.homeTeam,
                    awayTeam = match.awayTeam,
                    time = match.time,
                    channel = match.channel,
                    onClick = { openStream(match.deepLink) }
                )
            }
        }
    }
}
```

### Tela de Detalhes
```kotlin
@Composable
fun ContentDetailScreen(content: Content) {
    Column {
        BackdropImage(content.backdropPath)
        Row {
            PosterImage(content.posterPath)
            Column {
                Text(content.title, fontSize = 32.sp)
                Text("⭐ ${content.rating} • ${content.runtime}min")

                // Botão principal
                Button(
                    onClick = { openPrimaryApp(content) },
                    modifier = Modifier.focusable()
                ) {
                    Text("▶ Assistir ${content.primaryProvider}")
                }

                // Outras opções
                Button(
                    onClick = { showProvidersModal(content) },
                    colors = ButtonDefaults.outlinedButtonColors()
                ) {
                    Text("📋 Outras Opções")
                }

                // Ações
                Row {
                    IconButton({ addToWatchlist() }) { Icon(Icons.Add) }
                    IconButton({ markAsWatched() }) { Icon(Icons.Check) }
                }
            }
        }
        Text(content.overview)
    }
}
```

---

## 🚀 Roadmap de Desenvolvimento

### MVP 1 - Filmes/Séries Básico (2-3 semanas)
- [ ] Setup projeto Android Studio
- [ ] Configurar Room database
- [ ] Integrar TMDB API
- [ ] Tela Home básica
- [ ] Tela de detalhes
- [ ] Watchlist funcional
- [ ] Deep links para Netflix/Prime

### MVP 2 - Esportes (1-2 semanas)
- [ ] Integrar API-Football
- [ ] Integrar NBA API
- [ ] Seção "Jogos Hoje"
- [ ] Mapeamento canais Brasil
- [ ] Deep links ESPN/Globoplay

### MVP 3 - Chat IA (1 semana)
- [ ] Integrar Gemini API
- [ ] Interface de chat
- [ ] Contexto do histórico
- [ ] Sugestões personalizadas

### MVP 4 - Histórico & Polish (1 semana)
- [ ] Histórico de visualização
- [ ] Navegação por data
- [ ] Estatísticas
- [ ] Melhorias de UX/performance

---

## 🔒 Considerações de Segurança

### API Keys
- Armazenar em `local.properties` (não commitar)
- Usar BuildConfig para acessar
```properties
# local.properties
TMDB_API_KEY=your_key_here
GEMINI_API_KEY=your_key_here
FOOTBALL_API_KEY=your_key_here
```

### Permissions (AndroidManifest.xml)
```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.QUERY_ALL_PACKAGES" />
```

---

## 📦 Estrutura de Pastas

```
app/src/main/
├── java/com/yourname/googletvhome/
│   ├── data/
│   │   ├── local/
│   │   │   ├── dao/
│   │   │   ├── entities/
│   │   │   └── AppDatabase.kt
│   │   ├── remote/
│   │   │   ├── tmdb/
│   │   │   ├── sports/
│   │   │   └── gemini/
│   │   └── repository/
│   ├── domain/
│   │   ├── model/
│   │   └── usecase/
│   ├── presentation/
│   │   ├── home/
│   │   ├── detail/
│   │   ├── chat/
│   │   └── history/
│   └── utils/
│       ├── DeepLinkHelper.kt
│       └── AppDetector.kt
└── res/
```

---

## 🎯 Próximos Passos Imediatos

1. Criar projeto Android no Android Studio
2. Configurar Gradle com todas dependências
3. Setup Room database com entidades
4. Obter API keys (TMDB, Gemini, API-Football)
5. Criar repositórios e ViewModels
6. Implementar tela Home MVP

---

**Autor:** Claude
**Data:** 2025-12-31
**Versão:** 1.0
