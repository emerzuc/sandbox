package com.googletvhome

import android.app.Application
import dagger.hilt.android.HiltAndroidApp

@HiltAndroidApp
class GoogleTVHomeApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Inicializações futuras (ex: WorkManager, Firebase, etc.)
    }
}
