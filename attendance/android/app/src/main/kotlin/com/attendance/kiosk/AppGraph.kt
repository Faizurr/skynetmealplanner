package com.attendance.kiosk

import android.content.Context
import com.attendance.kiosk.core.crypto.AesGcmByteCipher
import com.attendance.kiosk.core.crypto.SecureBlobStore
import com.attendance.kiosk.core.queue.EncryptedQueueStore
import com.attendance.kiosk.core.queue.OfflineQueue
import com.attendance.kiosk.data.KeystoreKeys
import com.attendance.kiosk.data.KioskRepository
import com.attendance.kiosk.data.LocalStores
import com.attendance.kiosk.face.FaceEngine
import com.attendance.kiosk.face.FrameConverter
import com.attendance.kiosk.net.ConnectivityMonitor
import com.attendance.kiosk.update.UpdateManager
import com.attendance.kiosk.util.SuccessSound
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Manual dependency graph (the app is small; no DI framework). */
class AppGraph(context: Context) {
    val appContext: Context = context.applicationContext

    /** Long-lived background work (sync, heartbeat). Never touches the main thread. */
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** The single thread on which all camera frames are analysed. */
    val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "face-analysis").apply { priority = Thread.NORM_PRIORITY }
    }

    /** Used only on [analysisExecutor]. */
    val frameConverter = FrameConverter(maxSide = 640)

    private val cipher = AesGcmByteCipher { KeystoreKeys.storageKey() }
    private val stateBlobs = SecureBlobStore(File(appContext.filesDir, "secure"), cipher)
    private val queueDir = File(appContext.filesDir, "queue")
    private val queueBlobs = SecureBlobStore(queueDir, cipher)

    val stores = LocalStores(stateBlobs)
    val queue = OfflineQueue(EncryptedQueueStore(queueBlobs))
    val connectivity = ConnectivityMonitor(appContext)
    val faceEngine = FaceEngine(appContext)
    val sound = SuccessSound()

    val repository = KioskRepository(
        stores = stores,
        queue = queue,
        clearQueue = { queueBlobs.names().forEach { queueBlobs.delete(it) } },
        connectivity = connectivity,
        scope = appScope,
    )

    val updates = UpdateManager(appContext, repository)
}
