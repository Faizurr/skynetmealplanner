# --- OpenCV: JNI looks up Java classes/methods by name.
-keep class org.opencv.** { *; }
-dontwarn org.opencv.**

# --- kotlinx.serialization (the library ships consumer rules; these cover our DTOs explicitly).
-keepattributes *Annotation*, InnerClasses, Signature, EnclosingMethod
-dontnote kotlinx.serialization.**
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class com.attendance.kiosk.**$$serializer { *; }
-keepclassmembers class com.attendance.kiosk.** { *** Companion; }
-keepclasseswithmembers class com.attendance.kiosk.** { kotlinx.serialization.KSerializer serializer(...); }
-keep @kotlinx.serialization.Serializable class com.attendance.kiosk.** { *; }

# --- OkHttp / Okio (platform-specific optional classes).
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# --- Install-result receiver is referenced from the manifest (kept by AAPT rules) and by PendingIntent.
-keep class com.attendance.kiosk.update.InstallResultReceiver { *; }
