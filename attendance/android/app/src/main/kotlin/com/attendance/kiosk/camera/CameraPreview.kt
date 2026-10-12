package com.attendance.kiosk.camera

import android.util.Log
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Observer
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.util.concurrent.Executor

/** Why the camera could not be used. */
enum class CameraIssue(val message: String) {
    NO_FRONT_CAMERA("This device has no front camera. Please use your staff PIN."),
    IN_USE("The camera is being used by another app. Close it and try again."),
    DISABLED("The camera is disabled on this device (device policy)."),
    FAILED("The camera could not be started. Please try again."),
}

/**
 * Front-camera preview + frame analysis, bound to the composition's lifecycle. Everything is
 * unbound as soon as this leaves the composition, so the camera is never running on other
 * screens. Frames go to [analyzer] on [executor] (RGBA_8888, keep-only-latest).
 */
@Composable
fun CameraPreview(
    analyzer: ImageAnalysis.Analyzer,
    executor: Executor,
    onError: (CameraIssue) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val latestOnError by rememberUpdatedState(onError)
    val previewView = remember {
        PreviewView(context).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        }
    }

    AndroidView(factory = { previewView }, modifier = modifier)

    DisposableEffect(lifecycleOwner, analyzer) {
        val providerFuture = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        var analysis: ImageAnalysis? = null
        var cameraStateObserver: Observer<CameraState>? = null
        var observedState: androidx.lifecycle.LiveData<CameraState>? = null
        var disposed = false

        providerFuture.addListener({
            if (disposed) return@addListener
            try {
                val p = providerFuture.get()
                provider = p
                val selector = CameraSelector.DEFAULT_FRONT_CAMERA
                val hasFront = try {
                    p.hasCamera(selector)
                } catch (e: Exception) {
                    false
                }
                if (!hasFront) {
                    latestOnError(CameraIssue.NO_FRONT_CAMERA)
                    return@addListener
                }
                val preview = Preview.Builder().build()
                preview.setSurfaceProvider(previewView.surfaceProvider)
                val a = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                    .setResolutionSelector(
                        ResolutionSelector.Builder()
                            .setResolutionStrategy(
                                ResolutionStrategy(Size(640, 480), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER),
                            )
                            .build(),
                    )
                    .build()
                a.setAnalyzer(executor, analyzer)
                analysis = a
                p.unbindAll()
                val camera = p.bindToLifecycle(lifecycleOwner, selector, preview, a)
                val state = camera.cameraInfo.cameraState
                val observer = Observer<CameraState> { s ->
                    val err = s.error ?: return@Observer
                    val issue: CameraIssue? = when (err.code) {
                        CameraState.ERROR_CAMERA_IN_USE, CameraState.ERROR_MAX_CAMERAS_IN_USE -> CameraIssue.IN_USE
                        CameraState.ERROR_CAMERA_DISABLED -> CameraIssue.DISABLED
                        else -> if (err.type == CameraState.ErrorType.CRITICAL) CameraIssue.FAILED else null
                    }
                    if (issue != null) latestOnError(issue)
                }
                state.observe(lifecycleOwner, observer)
                cameraStateObserver = observer
                observedState = state
            } catch (e: Exception) {
                Log.e("CameraPreview", "Camera bind failed", e)
                latestOnError(CameraIssue.FAILED)
            }
        }, ContextCompat.getMainExecutor(context))

        onDispose {
            disposed = true
            cameraStateObserver?.let { obs -> observedState?.removeObserver(obs) }
            analysis?.clearAnalyzer()
            try {
                provider?.unbindAll()
            } catch (e: Exception) {
                Log.w("CameraPreview", "unbind failed", e)
            }
        }
    }
}
