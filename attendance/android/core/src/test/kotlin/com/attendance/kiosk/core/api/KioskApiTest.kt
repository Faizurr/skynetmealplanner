package com.attendance.kiosk.core.api

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class KioskApiTest {
    private lateinit var server: MockWebServer
    private lateinit var api: KioskApi
    private var token: String? = "device-token"

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
        val client = OkHttpClient.Builder().readTimeout(2, TimeUnit.SECONDS).build()
        api = KioskApi(server.url("/"), client) { token }
    }

    @AfterTest
    fun tearDown() = server.shutdown()

    private val successBody = """
        {"result":"recorded",
         "event":{"id":"e1","type":"check_in","event_time":"2026-10-12T01:02:05.000Z","verification_status":"verified",
                  "recorded_offline":false,"exception_flags":["late"],"server_received_at":"2026-10-12T01:02:05.100Z"},
         "employee":{"id":"emp1","full_name":"Sarah Lim","preferred_name":"Sarah","staff_id":"S001"},
         "session":{"id":"s1","check_in_at":"2026-10-12T01:02:05.000Z","check_out_at":null,"late_minutes":2,"is_late":true,
                    "worked_minutes":null,"break_minutes":0,"overtime_minutes":0,"scheduled_start":"2026-10-12T01:00:00.000Z","scheduled_end":null},
         "display":{"greeting":"Good morning, Sarah!","headline":"CHECK-IN SUCCESSFUL","time":"9:02 am","date":"12 October 2026",
                    "duration":null,"message":"Checked in 2 min after your scheduled start."},
         "future_field":123}
    """.trimIndent()

    @Test
    fun `attendance posts snake_case json with bearer token and parses the result`() {
        server.enqueue(MockResponse().setBody(successBody).setHeader("Content-Type", "application/json"))
        val r = api.attendance(
            AttendanceRequest(
                eventId = "0b9a7f8e-1111-4111-8111-111111111111", action = Action.CHECK_IN, method = Method.FACE,
                employeeId = "emp1", embedding = "AAAA", matchScore = 0.8, livenessPassed = true,
                deviceTimestamp = "2026-10-12T01:02:00Z", offline = false,
            ),
        )
        val ok = assertIs<ApiResult.Ok<AttendanceResult>>(r)
        assertEquals("CHECK-IN SUCCESSFUL", ok.value.display.headline)
        assertEquals(Action.CHECK_IN, ok.value.event.type)
        assertEquals(2, ok.value.session!!.lateMinutes)
        assertFalse(ok.value.isPendingReview)

        val req = server.takeRequest()
        assertEquals("/api/kiosk/attendance", req.path)
        assertEquals("POST", req.method)
        assertEquals("Bearer device-token", req.getHeader("Authorization"))
        val body = req.body.readUtf8()
        assertTrue(body.contains("\"event_id\":\"0b9a7f8e-1111-4111-8111-111111111111\""))
        assertTrue(body.contains("\"action\":\"check_in\""))
        assertTrue(body.contains("\"method\":\"face\""))
        assertTrue(body.contains("\"liveness_passed\":true"))
        assertTrue(body.contains("\"offline\":false"))
        assertFalse(body.contains("\"pin\""), "null fields are omitted")
        assertFalse(body.contains("staff_id"))
    }

    @Test
    fun `error bodies are parsed with details`() {
        server.enqueue(
            MockResponse().setResponseCode(409).setBody(
                """{"error":"already_checked_in","message":"You are already checked in since 9:02 am.","details":{"check_in_at":"2026-10-12T01:02:00.000Z"}}""",
            ),
        )
        val r = assertIs<ApiResult.Http>(api.attendance(AttendanceRequest("e", Action.CHECK_IN, Method.FACE, deviceTimestamp = "x", offline = false)))
        assertEquals(409, r.status)
        assertEquals("already_checked_in", r.code)
        assertEquals("2026-10-12T01:02:00.000Z", r.body?.detailString("check_in_at"))
    }

    @Test
    fun `non-json error body still yields a status`() {
        server.enqueue(MockResponse().setResponseCode(502).setBody("<html>Bad gateway</html>"))
        val r = assertIs<ApiResult.Http>(api.config())
        assertEquals(502, r.status)
        assertEquals("http_502", r.code)
        assertTrue(r.isServerError)
    }

    @Test
    fun `revoked device is recognised`() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"device_revoked","message":"revoked"}"""))
        assertTrue(assertIs<ApiResult.Http>(api.config()).isDeviceRevoked)
    }

    @Test
    fun `network failures are values, not exceptions`() {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        assertIs<ApiResult.Network>(api.heartbeat(HeartbeatRequest(pendingQueueCount = 0)))
        server.enqueue(MockResponse().setBody("{\"ok\":true}").setBodyDelay(5, TimeUnit.SECONDS))
        assertIs<ApiResult.Network>(api.heartbeat(HeartbeatRequest(pendingQueueCount = 0)))
    }

    @Test
    fun `malformed success body is a network-class error`() {
        server.enqueue(MockResponse().setBody("not json"))
        assertIs<ApiResult.Network>(api.config())
    }

    @Test
    fun `config parses with defaults for missing settings`() {
        server.enqueue(
            MockResponse().setBody(
                """{"server_time":"2026-10-12T01:00:00.000Z","restaurant":{"id":"r","name":"Nasi House","timezone":"Asia/Kuala_Lumpur"},
                   "branch":null,"device":{"id":"d","name":"Front kiosk"},"face_model":"opencv-sface-2021dec",
                   "settings":{"match_threshold":0.55,"liveness_required":false},"consent_notice_version":"2026-10-v1"}""",
            ),
        )
        val c = assertIs<ApiResult.Ok<KioskConfig>>(api.config()).value
        assertEquals("Nasi House", c.restaurant.name)
        assertNull(c.branch)
        assertEquals(0.55, c.settings.matchThreshold)
        assertEquals(0.06, c.settings.matchMargin)
        assertFalse(c.settings.livenessRequired)
        assertEquals(4, c.settings.successReturnSeconds)
        assertEquals("2026-10-v1", c.consentNoticeVersion)
    }

    @Test
    fun `templates support etag and 304`() {
        server.enqueue(MockResponse().setHeader("ETag", "\"abc\"").setBody("""{"model":"opencv-sface-2021dec","employees":[{"id":"1","full_name":"Sarah Lim","preferred_name":null,"staff_id":"S001","templates":["AAAA"]}]}"""))
        server.enqueue(MockResponse().setResponseCode(304))
        val first = assertIs<TemplatesFetch.Updated>(assertIs<ApiResult.Ok<TemplatesFetch>>(api.templates(null)).value)
        assertEquals("\"abc\"", first.etag)
        assertEquals("Sarah", first.response.employees.single().displayName)
        assertNull(server.takeRequest().getHeader("If-None-Match"))
        assertEquals(TemplatesFetch.NotModified, assertIs<ApiResult.Ok<TemplatesFetch>>(api.templates("\"abc\"")).value)
        assertEquals("\"abc\"", server.takeRequest().getHeader("If-None-Match"))
    }

    @Test
    fun `pairing is sent without a bearer token`() {
        token = null
        server.enqueue(MockResponse().setBody("""{"device_id":"d","device_token":"t"}"""))
        val r = assertIs<ApiResult.Ok<PairResponse>>(api.pair(PairRequest("K7Q-4MX-29P", "Pixel", "1.0.0")))
        assertEquals("t", r.value.deviceToken)
        val req = server.takeRequest()
        assertNull(req.getHeader("Authorization"))
        assertTrue(req.body.readUtf8().contains("\"code\":\"K7Q-4MX-29P\""))
    }

    @Test
    fun `manager calls carry the manager token`() {
        server.enqueue(MockResponse().setBody("""{"employees":[{"id":"1","full_name":"Sarah Lim","preferred_name":null,"staff_id":"S001","job_title":"Cook","status":"active","enrollment_status":null}]}"""))
        val r = assertIs<ApiResult.Ok<ManagerEmployeesResponse>>(api.managerEmployees("mgr"))
        assertNull(r.value.employees.single().enrollmentStatus)
        val req = server.takeRequest()
        assertEquals("mgr", req.getHeader("X-Manager-Token"))
        assertEquals("Bearer device-token", req.getHeader("Authorization"))
    }

    @Test
    fun `enrollment request body matches the API contract`() {
        server.enqueue(MockResponse().setBody("""{"enrollment_id":"en","status":"active","employee":{"id":"1","full_name":"Sarah Lim"}}"""))
        api.enroll(
            "mgr",
            EnrollmentRequest("1", listOf("A", "B", "C"), Consent(true, ConsentMethod.DIGITAL_ACKNOWLEDGEMENT, "2026-10-v1"), confirmIdentity = true),
        )
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"consent\":{\"confirmed\":true,\"method\":\"digital_acknowledgement\",\"notice_version\":\"2026-10-v1\"}"))
        assertTrue(body.contains("\"confirm_identity\":true"))
        assertFalse(body.contains("photo_jpeg_base64"))
    }

    @Test
    fun `latest release passes the current version code`() {
        server.enqueue(MockResponse().setBody("""{"release":null,"update_available":false,"mandatory":false}"""))
        val r = assertIs<ApiResult.Ok<LatestReleaseResponse>>(api.latestRelease(7))
        assertNull(r.value.release)
        assertEquals("/api/app/android/latest?current=7", server.takeRequest().path)
    }

    @Test
    fun `base url with a sub path is respected`() {
        val sub = KioskApi(server.url("/attendance/"), OkHttpClient()) { "t" }
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        sub.unknownFace(UnknownFaceRequest(Action.CHECK_OUT, 0.31))
        val req = server.takeRequest()
        assertEquals("/attendance/api/kiosk/unknown-face", req.path)
        assertTrue(req.body.readUtf8().contains("\"best_score\":0.31"))
    }
}
