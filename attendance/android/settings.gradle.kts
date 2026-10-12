// Attendance kiosk – Android project.
//
// :core is a pure Kotlin/JVM module (all platform-independent logic + unit tests).
// :app is the Android application. It is only included when an Android SDK is available,
// so `./gradlew :core:test` works on machines/CI runners without the Android SDK.

pluginManagement {
    repositories {
        // Google's repository is only consulted for Android/Google artifacts.
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
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
}

rootProject.name = "attendance-kiosk"

include(":core")

fun androidSdkAvailable(): Boolean {
    if (!System.getenv("ANDROID_HOME").isNullOrBlank()) return true
    if (!System.getenv("ANDROID_SDK_ROOT").isNullOrBlank()) return true
    val local = file("local.properties")
    if (!local.exists()) return false
    val props = java.util.Properties()
    local.inputStream().use { props.load(it) }
    return !props.getProperty("sdk.dir").isNullOrBlank()
}

val kioskHasAndroidSdk = androidSdkAvailable()
gradle.extra["kioskHasAndroidSdk"] = kioskHasAndroidSdk
if (kioskHasAndroidSdk) {
    include(":app")
} else {
    logger.lifecycle("Android SDK not found (ANDROID_HOME / ANDROID_SDK_ROOT / local.properties sdk.dir): building :core only.")
}
