import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.Properties

plugins {
    // AGP is on the root buildscript classpath (see ../build.gradle.kts), hence no version here.
    id("com.android.application")
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// ---------------------------------------------------------------------------------------
// Release signing: environment variables first, then keystore.properties (gitignored).
// Without them the release APK is built UNSIGNED (sign it later with apksigner).
// ---------------------------------------------------------------------------------------
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

fun signingValue(env: String, prop: String): String? =
    System.getenv(env)?.takeIf { it.isNotBlank() } ?: keystoreProps.getProperty(prop)?.takeIf { it.isNotBlank() }

val releaseStoreFile = signingValue("KIOSK_KEYSTORE_PATH", "storeFile")?.let { rootProject.file(it) }
val releaseStorePassword = signingValue("KIOSK_KEYSTORE_PASSWORD", "storePassword")
val releaseKeyAlias = signingValue("KIOSK_KEY_ALIAS", "keyAlias")
val releaseKeyPassword = signingValue("KIOSK_KEY_PASSWORD", "keyPassword")
val hasReleaseSigning = releaseStoreFile?.exists() == true &&
    releaseStorePassword != null && releaseKeyAlias != null && releaseKeyPassword != null

if (!hasReleaseSigning) {
    logger.lifecycle("Kiosk: no release signing configured (KIOSK_KEYSTORE_* or keystore.properties); release APK will be unsigned.")
}

val kioskVersionCode = (findProperty("kioskVersionCode") as String?)?.toIntOrNull() ?: 1
val kioskVersionName = (findProperty("kioskVersionName") as String?) ?: "1.0.0"

android {
    namespace = "com.attendance.kiosk"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.attendance.kiosk"
        minSdk = 26
        targetSdk = 35
        versionCode = kioskVersionCode
        versionName = kioskVersionName
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        }
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = releaseStoreFile
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
        }
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/versions/9/OSGI-INF/MANIFEST.MF")
        }
    }

    // ONNX models are large and already compressed poorly; keep them uncompressed in the APK.
    androidResources {
        noCompress += "onnx"
    }

    lint {
        // lintVital must not block CI on first integration; run `./gradlew :app:lint` for the full report.
        checkReleaseBuilds = false
        abortOnError = false
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// ---------------------------------------------------------------------------------------
// Face models: copied from attendance/models (fetched by attendance/scripts/fetch-models.sh)
// into generated assets/models/. The build fails clearly if they are missing.
// ---------------------------------------------------------------------------------------
val faceModelNames = listOf("face_detection_yunet_2023mar.onnx", "face_recognition_sface_2021dec.onnx")
val faceModelsDir: File = rootProject.file("../models")

abstract class CopyFaceModelsTask : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NAME_ONLY)
    abstract val modelFiles: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copyModels() {
        val out = outputDir.get().asFile.resolve("models")
        out.deleteRecursively()
        out.mkdirs()
        modelFiles.files.forEach { src ->
            if (!src.isFile) throw GradleException("Missing face model ${src.absolutePath}. Run attendance/scripts/fetch-models.sh first.")
            src.copyTo(out.resolve(src.name), overwrite = true)
        }
    }
}

val verifyFaceModels by tasks.registering {
    description = "Fails early if the YuNet/SFace models have not been fetched."
    val files = faceModelNames.map { faceModelsDir.resolve(it) }
    inputs.files(files).optional()
    doLast {
        val missing = files.filterNot { it.isFile }
        if (missing.isNotEmpty()) {
            throw GradleException(
                "Face models missing: ${missing.joinToString { it.name }} in ${faceModelsDir.absolutePath}.\n" +
                    "Run: attendance/scripts/fetch-models.sh",
            )
        }
    }
}

tasks.named("preBuild") { dependsOn(verifyFaceModels) }

androidComponents {
    onVariants { variant ->
        val copy = tasks.register<CopyFaceModelsTask>("copy${variant.name.replaceFirstChar { it.uppercase() }}FaceModels") {
            dependsOn(verifyFaceModels)
            modelFiles.from(faceModelNames.map { faceModelsDir.resolve(it) })
        }
        variant.sources.assets?.addGeneratedSourceDirectory(copy, CopyFaceModelsTask::outputDir)
    }
}

dependencies {
    implementation(project(":core"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)

    implementation(libs.opencv)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
}
