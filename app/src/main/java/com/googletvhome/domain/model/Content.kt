package com.googletvhome.domain.model

/**
 * Modelo de domínio para Filmes e Séries
 */
data class Content(
    val id: Int,
    val tmdbId: Int,
    val type: ContentType,
    val title: String,
    val posterPath: String?,
    val backdropPath: String?,
    val overview: String,
    val rating: Double,
    val releaseDate: String,
    val genres: List<String>,
    val runtime: Int?,
    val status: ContentStatus,
    val providers: List<StreamingProvider> = emptyList(),
    val addedAt: Long,
    val lastWatchedAt: Long? = null
)

enum class ContentType {
    MOVIE,
    SERIES
}

enum class ContentStatus {
    WATCHLIST,      // Quer assistir
    WATCHING,       // Assistindo (série em andamento)
    COMPLETED       // Já assistiu
}

data class StreamingProvider(
    val id: Int,
    val name: String,
    val logoPath: String?,
    val packageName: String?, // Package do app Android (ex: "com.netflix.ninja")
    val deepLinkTemplate: String? // Template de deep link
)
