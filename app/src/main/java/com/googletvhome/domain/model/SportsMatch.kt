package com.googletvhome.domain.model

import java.time.LocalDateTime

/**
 * Modelo de domínio para Jogos Esportivos
 */
data class SportsMatch(
    val id: String,
    val sport: SportType,
    val homeTeam: String,
    val awayTeam: String,
    val homeTeamLogo: String?,
    val awayTeamLogo: String?,
    val league: String,
    val matchDate: LocalDateTime,
    val venue: String?,
    val isLive: Boolean = false,
    val broadcastInfo: BroadcastInfo?
)

enum class SportType {
    FOOTBALL,
    NBA
}

data class BroadcastInfo(
    val channel: String?,           // "Globo", "ESPN", "Premiere"
    val streamingPlatform: String?, // "Prime Video", "Disney+"
    val deepLink: String?,          // Link direto para assistir
    val requiresSubscription: Boolean = true
)
