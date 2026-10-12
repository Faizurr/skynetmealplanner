package com.attendance.kiosk.core.api

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.serializer
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException

/**
 * Blocking client for the Kiosk API (docs/API.md). Call from a background thread.
 *
 * @param baseUrl the server base URL chosen at pairing time.
 * @param deviceToken supplies the bearer token (null before pairing).
 */
class KioskApi(
    val baseUrl: HttpUrl,
    private val client: OkHttpClient,
    private val deviceToken: () -> String?,
) {
    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()

        fun parseBaseUrl(url: String): HttpUrl? = url.trim().trimEnd('/').toHttpUrlOrNull()
    }

    fun pair(body: PairRequest): ApiResult<PairResponse> = post("api/kiosk/pair", body, auth = false)

    fun config(): ApiResult<KioskConfig> = get("api/kiosk/config")

    /** Fetches templates; returns [TemplatesFetch.NotModified] when [etag] still matches. */
    fun templates(etag: String?): ApiResult<TemplatesFetch> {
        val req = request("api/kiosk/templates").apply { if (etag != null) header("If-None-Match", etag) }.get().build()
        return execute(req) { resp ->
            if (resp.code == 304) {
                ApiResult.Ok(TemplatesFetch.NotModified)
            } else {
                parseBody(resp, serializer<TemplatesResponse>()).map { TemplatesFetch.Updated(it, resp.header("ETag")) }
            }
        }
    }

    fun attendance(body: AttendanceRequest): ApiResult<AttendanceResult> = post("api/kiosk/attendance", body)

    fun unknownFace(body: UnknownFaceRequest): ApiResult<OkResponse> = post("api/kiosk/unknown-face", body)

    fun heartbeat(body: HeartbeatRequest): ApiResult<OkResponse> = post("api/kiosk/heartbeat", body)

    fun managerLogin(body: ManagerLoginRequest): ApiResult<ManagerLoginResponse> = post("api/kiosk/manager/login", body)

    fun managerEmployees(managerToken: String): ApiResult<ManagerEmployeesResponse> =
        get("api/kiosk/manager/employees", managerToken)

    fun enroll(managerToken: String, body: EnrollmentRequest): ApiResult<EnrollmentResponse> =
        post("api/kiosk/manager/enrollments", body, managerToken = managerToken)

    fun verify(managerToken: String, body: VerifyRequest): ApiResult<VerifyResponse> =
        post("api/kiosk/manager/verify", body, managerToken = managerToken)

    fun latestRelease(currentVersionCode: Int): ApiResult<LatestReleaseResponse> {
        val url = baseUrl.newBuilder().addPathSegments("api/app/android/latest")
            .addQueryParameter("current", currentVersionCode.toString()).build()
        return execute(Request.Builder().url(url).header("Accept", "application/json").get().build()) {
            parseBody(it, serializer<LatestReleaseResponse>())
        }
    }

    // ------------------------------------------------------------------------------------

    private fun request(path: String, auth: Boolean = true, managerToken: String? = null): Request.Builder {
        val b = Request.Builder().url(baseUrl.newBuilder().addPathSegments(path).build())
            .header("Accept", "application/json")
        if (auth) deviceToken()?.let { b.header("Authorization", "Bearer $it") }
        if (managerToken != null) b.header("X-Manager-Token", managerToken)
        return b
    }

    private inline fun <reified T> get(path: String, managerToken: String? = null): ApiResult<T> =
        execute(request(path, managerToken = managerToken).get().build()) { parseBody(it, serializer<T>()) }

    private inline fun <reified B, reified T> post(
        path: String,
        body: B,
        auth: Boolean = true,
        managerToken: String? = null,
    ): ApiResult<T> {
        val json = KioskJson.encodeToString(serializer<B>(), body)
        val req = request(path, auth, managerToken).post(json.toRequestBody(JSON)).build()
        return execute(req) { parseBody(it, serializer<T>()) }
    }

    private fun <T> execute(req: Request, onResponse: (Response) -> ApiResult<T>): ApiResult<T> = try {
        client.newCall(req).execute().use { resp ->
            if (resp.isSuccessful || resp.code == 304) onResponse(resp) else ApiResult.Http(resp.code, parseError(resp))
        }
    } catch (e: IOException) {
        ApiResult.Network(e)
    }

    private fun <T> parseBody(resp: Response, ser: KSerializer<T>): ApiResult<T> {
        val text = resp.body?.string() ?: ""
        return try {
            ApiResult.Ok(KioskJson.decodeFromString(ser, text))
        } catch (e: SerializationException) {
            ApiResult.Network(IOException("Unexpected response from server (${resp.code})", e))
        } catch (e: IllegalArgumentException) {
            ApiResult.Network(IOException("Unexpected response from server (${resp.code})", e))
        }
    }

    private fun parseError(resp: Response): ErrorBody? = try {
        val text = resp.body?.string().orEmpty()
        if (text.isBlank()) null else KioskJson.decodeFromString(ErrorBody.serializer(), text)
    } catch (e: Exception) {
        null
    }
}

sealed interface TemplatesFetch {
    data object NotModified : TemplatesFetch
    data class Updated(val response: TemplatesResponse, val etag: String?) : TemplatesFetch
}
