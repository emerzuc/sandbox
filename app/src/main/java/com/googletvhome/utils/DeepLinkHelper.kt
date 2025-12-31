package com.googletvhome.utils

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri

/**
 * Helper para gerenciar deep links de apps de streaming
 */
object DeepLinkHelper {

    /**
     * Mapeamento de providers para packages Android
     */
    val STREAMING_PACKAGES = mapOf(
        "Netflix" to "com.netflix.ninja",
        "Prime Video" to "com.amazon.avod.thirdpartyclient",
        "Disney+" to "com.disney.disneyplus",
        "HBO Max" to "com.hbo.hbonow",
        "Globoplay" to "com.globo.globoplay",
        "Stremio" to "com.stremio.one",
        "Paramount+" to "com.cbs.ott",
        "Apple TV+" to "com.apple.atve.androidtv.appletv",
        "Star+" to "com.disney.disneyplus" // Integrado ao Disney+
    )

    /**
     * Verifica se um app está instalado
     */
    fun isAppInstalled(context: Context, packageName: String): Boolean {
        return try {
            context.packageManager.getPackageInfo(packageName, 0)
            true
        } catch (e: PackageManager.NameNotFoundException) {
            false
        }
    }

    /**
     * Retorna lista de apps de streaming instalados
     */
    fun getInstalledStreamingApps(context: Context): List<Pair<String, String>> {
        return STREAMING_PACKAGES.filter { (_, pkg) ->
            isAppInstalled(context, pkg)
        }.map { it.toPair() }
    }

    /**
     * Abre deep link de conteúdo no app apropriado
     */
    fun openContent(
        context: Context,
        provider: String,
        contentId: String,
        contentType: String = "movie" // ou "tv"
    ): Boolean {
        val packageName = STREAMING_PACKAGES[provider] ?: return false

        if (!isAppInstalled(context, packageName)) {
            return false
        }

        val deepLink = when (provider) {
            "Netflix" -> buildNetflixDeepLink(contentId)
            "Prime Video" -> buildPrimeVideoDeepLink(contentId)
            "Disney+" -> buildDisneyPlusDeepLink(contentId)
            "Stremio" -> buildStremioDeepLink(contentId, contentType)
            "Globoplay" -> buildGloboplayDeepLink(contentId)
            else -> null
        }

        return deepLink?.let {
            try {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(it))
                intent.setPackage(packageName)
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
                true
            } catch (e: Exception) {
                false
            }
        } ?: false
    }

    /**
     * Deep link builders para cada plataforma
     */
    private fun buildNetflixDeepLink(netflixId: String): String {
        return "netflix://title/$netflixId"
    }

    private fun buildPrimeVideoDeepLink(asin: String): String {
        return "intent://www.amazon.com.br/gp/video/detail/$asin#Intent;scheme=https;package=com.amazon.avod.thirdpartyclient;end"
    }

    private fun buildDisneyPlusDeepLink(contentId: String): String {
        return "https://www.disneyplus.com/video/$contentId"
    }

    private fun buildStremioDeepLink(imdbId: String, type: String): String {
        // type: "movie" ou "series"
        return "stremio://detail/$type/$imdbId"
    }

    private fun buildGloboplayDeepLink(contentId: String): String {
        return "globoplay://media/$contentId"
    }

    /**
     * Abre canal de esporte (ESPN, Globo, etc.)
     */
    fun openSportsChannel(context: Context, channel: String): Boolean {
        val intent = when (channel.lowercase()) {
            "espn", "espn brasil" -> {
                Intent(Intent.ACTION_VIEW).apply {
                    setPackage("com.espn.score_center")
                }
            }
            "globo", "sportv", "premiere" -> {
                Intent(Intent.ACTION_VIEW).apply {
                    setPackage("com.globo.globoplay")
                }
            }
            "prime video" -> {
                Intent(Intent.ACTION_VIEW).apply {
                    setPackage("com.amazon.avod.thirdpartyclient")
                }
            }
            else -> null
        }

        return intent?.let {
            try {
                it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(it)
                true
            } catch (e: Exception) {
                false
            }
        } ?: false
    }
}
