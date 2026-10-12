// Root build. The Android Gradle Plugin is put on the root build classpath only when the
// Android SDK is available (see settings.gradle.kts), so that :core builds without access
// to Google's Maven repository. AGP and the Kotlin plugin must share a classloader, which
// is why both are declared here and applied without versions in :app.
buildscript {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
    }
    dependencies {
        val hasSdk = gradle.extra.has("kioskHasAndroidSdk") && gradle.extra["kioskHasAndroidSdk"] == true
        if (hasSdk) {
            classpath(libs.android.gradle.plugin)
        }
    }
}

plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.kotlin.compose) apply false
}
