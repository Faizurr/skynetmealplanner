package com.attendance.kiosk.core.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** JSON configuration shared by the API client and on-device stores. */
val KioskJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    coerceInputValues = true
    isLenient = false
}

/** The employee's requested action. Always the button they tapped; never changed by the app. */
@Serializable
enum class Action(val wire: String) {
    @SerialName("check_in") CHECK_IN("check_in"),
    @SerialName("check_out") CHECK_OUT("check_out");

    val opposite: Action get() = if (this == CHECK_IN) CHECK_OUT else CHECK_IN
}

@Serializable
enum class Method {
    @SerialName("face") FACE,
    @SerialName("pin") PIN,
}

// --- Errors -----------------------------------------------------------------------------

@Serializable
data class ErrorBody(
    val error: String,
    val message: String? = null,
    val details: JsonObject? = null,
) {
    fun detailString(key: String): String? = (details?.get(key) as? JsonPrimitive)?.contentOrNull
}

// --- Pairing ----------------------------------------------------------------------------

@Serializable
data class PairRequest(
    val code: String,
    @SerialName("device_model") val deviceModel: String? = null,
    @SerialName("app_version") val appVersion: String? = null,
)

@Serializable
data class PairResponse(
    @SerialName("device_id") val deviceId: String,
    @SerialName("device_token") val deviceToken: String,
)

// --- Config -----------------------------------------------------------------------------

@Serializable
data class Restaurant(val id: String, val name: String, val timezone: String = "Asia/Kuala_Lumpur")

@Serializable
data class Branch(val id: String, val name: String)

@Serializable
data class DeviceRef(val id: String, val name: String)

@Serializable
data class KioskSettings(
    @SerialName("match_threshold") val matchThreshold: Double = 0.5,
    @SerialName("match_margin") val matchMargin: Double = 0.06,
    @SerialName("liveness_required") val livenessRequired: Boolean = true,
    @SerialName("pin_fallback_enabled") val pinFallbackEnabled: Boolean = true,
    @SerialName("success_return_seconds") val successReturnSeconds: Int = 4,
    @SerialName("sound_enabled") val soundEnabled: Boolean = true,
    @SerialName("employee_instructions") val employeeInstructions: String =
        "Tap CHECK IN when you arrive and CHECK OUT when you leave.",
    @SerialName("offline_mode_enabled") val offlineModeEnabled: Boolean = true,
    @SerialName("max_offline_age_hours") val maxOfflineAgeHours: Int = 72,
    @SerialName("min_minutes_between_in_and_out") val minMinutesBetweenInAndOut: Int = 1,
)

@Serializable
data class KioskConfig(
    @SerialName("server_time") val serverTime: String? = null,
    val restaurant: Restaurant,
    val branch: Branch? = null,
    val device: DeviceRef,
    @SerialName("face_model") val faceModel: String = FACE_MODEL,
    val settings: KioskSettings = KioskSettings(),
    @SerialName("consent_notice_version") val consentNoticeVersion: String = "",
)

const val FACE_MODEL = "opencv-sface-2021dec"

// --- Templates --------------------------------------------------------------------------

@Serializable
data class TemplateEmployee(
    val id: String,
    @SerialName("full_name") val fullName: String,
    @SerialName("preferred_name") val preferredName: String? = null,
    @SerialName("staff_id") val staffId: String,
    val templates: List<String> = emptyList(),
) {
    val displayName: String get() = preferredName?.takeIf { it.isNotBlank() } ?: fullName.substringBefore(' ')
}

@Serializable
data class TemplatesResponse(
    val model: String = FACE_MODEL,
    val employees: List<TemplateEmployee> = emptyList(),
)

// --- Attendance -------------------------------------------------------------------------

@Serializable
data class AttendanceRequest(
    @SerialName("event_id") val eventId: String,
    val action: Action,
    val method: Method,
    @SerialName("employee_id") val employeeId: String? = null,
    val embedding: String? = null,
    @SerialName("match_score") val matchScore: Double? = null,
    @SerialName("liveness_passed") val livenessPassed: Boolean? = null,
    @SerialName("staff_id") val staffId: String? = null,
    val pin: String? = null,
    @SerialName("device_timestamp") val deviceTimestamp: String,
    val offline: Boolean,
)

@Serializable
data class AttendanceEvent(
    val id: String,
    val type: Action,
    @SerialName("event_time") val eventTime: String,
    @SerialName("verification_status") val verificationStatus: String,
    @SerialName("recorded_offline") val recordedOffline: Boolean = false,
    @SerialName("exception_flags") val exceptionFlags: List<String> = emptyList(),
    @SerialName("server_received_at") val serverReceivedAt: String? = null,
)

@Serializable
data class EmployeeRef(
    val id: String,
    @SerialName("full_name") val fullName: String,
    @SerialName("preferred_name") val preferredName: String? = null,
    @SerialName("staff_id") val staffId: String? = null,
)

@Serializable
data class SessionDto(
    val id: String,
    @SerialName("check_in_at") val checkInAt: String,
    @SerialName("check_out_at") val checkOutAt: String? = null,
    @SerialName("late_minutes") val lateMinutes: Int = 0,
    @SerialName("is_late") val isLate: Boolean = false,
    @SerialName("worked_minutes") val workedMinutes: Int? = null,
    @SerialName("break_minutes") val breakMinutes: Int = 0,
    @SerialName("overtime_minutes") val overtimeMinutes: Int = 0,
    @SerialName("scheduled_start") val scheduledStart: String? = null,
    @SerialName("scheduled_end") val scheduledEnd: String? = null,
)

@Serializable
data class DisplayDto(
    val greeting: String,
    val headline: String,
    val time: String,
    val date: String,
    val duration: String? = null,
    val message: String = "",
)

@Serializable
data class AttendanceResult(
    val result: String,
    val event: AttendanceEvent,
    val employee: EmployeeRef,
    val session: SessionDto? = null,
    val display: DisplayDto,
) {
    val isPendingReview: Boolean get() = result == "pending_review" || event.verificationStatus == "pending_review"
}

@Serializable
data class UnknownFaceRequest(
    val action: Action,
    @SerialName("best_score") val bestScore: Double? = null,
)

@Serializable
data class OkResponse(val ok: Boolean = true, @SerialName("server_time") val serverTime: String? = null)

@Serializable
data class HeartbeatRequest(
    @SerialName("app_version") val appVersion: String? = null,
    @SerialName("app_version_code") val appVersionCode: Int? = null,
    @SerialName("pending_queue_count") val pendingQueueCount: Int,
    @SerialName("failed_queue_count") val failedQueueCount: Int = 0,
    @SerialName("last_error") val lastError: String? = null,
    val synced: Boolean = false,
)

// --- Manager mode -----------------------------------------------------------------------

@Serializable
data class ManagerLoginRequest(val email: String, val password: String)

@Serializable
data class ManagerLoginResponse(
    @SerialName("manager_token") val managerToken: String,
    @SerialName("full_name") val fullName: String,
    val role: String,
    @SerialName("expires_in_seconds") val expiresInSeconds: Int = 900,
)

@Serializable
data class ManagerEmployee(
    val id: String,
    @SerialName("full_name") val fullName: String,
    @SerialName("preferred_name") val preferredName: String? = null,
    @SerialName("staff_id") val staffId: String,
    @SerialName("job_title") val jobTitle: String? = null,
    val status: String = "active",
    @SerialName("enrollment_status") val enrollmentStatus: String? = null,
)

@Serializable
data class ManagerEmployeesResponse(val employees: List<ManagerEmployee> = emptyList())

@Serializable
enum class ConsentMethod(val label: String) {
    @SerialName("written_form") WRITTEN_FORM("Written consent form signed"),
    @SerialName("digital_acknowledgement") DIGITAL_ACKNOWLEDGEMENT("Employee acknowledged on this screen"),
    @SerialName("verbal_witnessed") VERBAL_WITNESSED("Verbal consent, witnessed by me"),
}

@Serializable
data class Consent(
    val confirmed: Boolean,
    val method: ConsentMethod,
    @SerialName("notice_version") val noticeVersion: String,
)

@Serializable
data class EnrollmentRequest(
    @SerialName("employee_id") val employeeId: String,
    val embeddings: List<String>,
    val consent: Consent,
    @SerialName("confirm_identity") val confirmIdentity: Boolean,
    @SerialName("photo_jpeg_base64") val photoJpegBase64: String? = null,
)

@Serializable
data class EnrollmentResponse(
    @SerialName("enrollment_id") val enrollmentId: String,
    val status: String,
    val employee: EmployeeRef,
)

@Serializable
data class VerifyRequest(val embedding: String)

@Serializable
data class VerifyResponse(
    val accepted: Boolean,
    val reason: String? = null,
    val score: Double,
    val employee: EmployeeRef? = null,
)

// --- Updates ----------------------------------------------------------------------------

@Serializable
data class ReleaseInfo(
    @SerialName("version_code") val versionCode: Int,
    @SerialName("version_name") val versionName: String,
    @SerialName("apk_url") val apkUrl: String,
    @SerialName("apk_sha256") val apkSha256: String,
    @SerialName("signing_cert_sha256") val signingCertSha256: String,
    @SerialName("min_supported_version_code") val minSupportedVersionCode: Int = 0,
    @SerialName("release_notes") val releaseNotes: String? = null,
    @SerialName("published_at") val publishedAt: String? = null,
)

@Serializable
data class LatestReleaseResponse(
    val release: ReleaseInfo? = null,
    @SerialName("update_available") val updateAvailable: Boolean = false,
    val mandatory: Boolean = false,
)
