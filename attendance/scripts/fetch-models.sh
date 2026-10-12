#!/usr/bin/env bash
# Downloads the OpenCV Zoo face models used by the kiosk (and tools/face-eval) into
# attendance/models/, skipping files that are already present, and verifies SHA-256.
#   YuNet face detector   (MIT)        face_detection_yunet_2023mar.onnx
#   SFace face recognizer (Apache-2.0) face_recognition_sface_2021dec.onnx
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/models"
BASE="https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models"
mkdir -p "$DEST"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

fetch() {
  local name="$1" url="$2" expected="$3"
  local target="$DEST/$name"
  if [[ -f "$target" ]]; then
    echo "• $name already present"
  else
    echo "• downloading $name"
    local tmp
    tmp="$(mktemp "$DEST/.${name}.XXXXXX")"
    if ! curl -fL --retry 3 --retry-delay 2 -o "$tmp" "$url"; then
      rm -f "$tmp"
      echo "ERROR: download failed: $url" >&2
      exit 1
    fi
    mv "$tmp" "$target"
    chmod 644 "$target"
  fi
  local actual
  actual="$(sha256_of "$target")"
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: SHA-256 mismatch for $name" >&2
    echo "  expected $expected" >&2
    echo "  actual   $actual" >&2
    echo "  (delete $target and re-run; if it persists the upstream file changed)" >&2
    exit 1
  fi
  echo "  ✓ sha256 $actual"
}

fetch face_detection_yunet_2023mar.onnx \
  "$BASE/face_detection_yunet/face_detection_yunet_2023mar.onnx" \
  8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4

fetch face_recognition_sface_2021dec.onnx \
  "$BASE/face_recognition_sface/face_recognition_sface_2021dec.onnx" \
  0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79

echo "Models ready in $DEST"
