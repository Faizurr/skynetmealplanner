#!/usr/bin/env python3
"""
Face pipeline sanity check for the kiosk recognition engine.

Runs the SAME OpenCV components the Android kiosk uses:
  * YuNet face detector  (cv2.FaceDetectorYN, face_detection_yunet_2023mar.onnx, MIT)
  * SFace face recognizer (cv2.FaceRecognizerSF, face_recognition_sface_2021dec.onnx, Apache-2.0)
on a small set of PUBLIC labelled photos, and reports genuine (same person) and impostor
(different people) cosine similarity distributions.

This is a pipeline sanity check on a handful of public photos, NOT an accuracy benchmark.
Real-world accuracy must be measured on the restaurant's own hardware, lighting and staff
(see docs/FACE_RECOGNITION.md for the on-site evaluation procedure).

Usage:  python3 -I tools/face-eval/eval.py [--out docs/FACE_EVAL_RESULTS.md]
"""
import argparse
import hashlib
import itertools
import json
import os
import sys
import urllib.request

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
MODELS = os.path.join(ROOT, 'models')
DATA = os.path.join(HERE, 'data')

DETECTOR = os.path.join(MODELS, 'face_detection_yunet_2023mar.onnx')
RECOGNIZER = os.path.join(MODELS, 'face_recognition_sface_2021dec.onnx')
MODEL_SHA256 = {
    DETECTOR: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    RECOGNIZER: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
}

# Public example images from the MIT-licensed ageitgey/face_recognition repository.
BASE = 'https://raw.githubusercontent.com/ageitgey/face_recognition/master/'
SINGLE = {
    'obama': ['examples/knn_examples/train/obama/obama.jpg', 'examples/knn_examples/train/obama/obama2.jpg',
              'tests/test_images/obama.jpg', 'tests/test_images/obama2.jpg', 'tests/test_images/obama3.jpg',
              'examples/obama_small.jpg', 'examples/obama-480p.jpg', 'examples/knn_examples/test/obama1.jpg'],
    'biden': ['examples/knn_examples/train/biden/biden.jpg', 'examples/knn_examples/train/biden/biden2.jpg',
              'tests/test_images/biden.jpg'],
    'alex_lacamoire': ['examples/alex-lacamoire.png', 'examples/knn_examples/train/alex_lacamoire/img1.jpg',
                       'examples/knn_examples/test/alex_lacamoire1.jpg'],
    'kit_harington': ['examples/knn_examples/train/kit_harington/john1.jpeg',
                      'examples/knn_examples/train/kit_harington/john2.jpeg',
                      'examples/knn_examples/test/johnsnow_test1.jpg'],
    'rose_leslie': ['examples/knn_examples/train/rose_leslie/img1.jpg', 'examples/knn_examples/train/rose_leslie/img2.jpg'],
    'lin_manuel_miranda': ['examples/lin-manuel-miranda.png'],
}
MULTI = ['examples/two_people.jpg', 'examples/knn_examples/test/obama_and_biden.jpg', 'examples/knn_examples/test/kit_with_rose.jpg']

SCORE_THRESHOLD = 0.8   # YuNet detection confidence (same as kiosk)
MIN_FACE_PX = 80        # kiosk rejects faces smaller than this (too far away)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def fetch(rel):
    os.makedirs(DATA, exist_ok=True)
    dst = os.path.join(DATA, rel.replace('/', '__'))
    if not os.path.exists(dst):
        urllib.request.urlretrieve(BASE + rel, dst)
    return dst


def load_models():
    for p, digest in MODEL_SHA256.items():
        if not os.path.exists(p):
            sys.exit(f'Missing model {p}. Run scripts/fetch-models.sh first.')
        if sha256(p) != digest:
            sys.exit(f'Checksum mismatch for {p}')
    det = cv2.FaceDetectorYN.create(DETECTOR, '', (320, 320), SCORE_THRESHOLD, 0.3, 5000)
    rec = cv2.FaceRecognizerSF.create(RECOGNIZER, '')
    return det, rec


def detect(det, img):
    h, w = img.shape[:2]
    # Kiosk downsizes camera frames to <= 640px on the long side before detection.
    scale = min(1.0, 640.0 / max(h, w))
    if scale < 1.0:
        img = cv2.resize(img, (int(w * scale), int(h * scale)))
        h, w = img.shape[:2]
    det.setInputSize((w, h))
    _, faces = det.detect(img)
    return img, ([] if faces is None else list(faces))


def embed(rec, img, face):
    aligned = rec.alignCrop(img, face)
    feat = rec.feature(aligned).flatten().astype(np.float32)
    return feat / np.linalg.norm(feat)


def yaw_ratio(face):
    """Same head-turn metric the kiosk liveness challenge uses (nose offset / eye distance)."""
    rx, ry, lx, ly, nx, ny = face[4], face[5], face[6], face[7], face[8], face[9]
    eye_mid = (rx + lx) / 2.0
    eye_dist = max(1.0, abs(lx - rx))
    return (nx - eye_mid) / eye_dist


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'docs', 'FACE_EVAL_RESULTS.md'))
    args = ap.parse_args()
    det, rec = load_models()

    samples = []  # (identity, file, embedding, face_px, det_score, yaw)
    skipped = []
    seen = set()
    for ident, files in SINGLE.items():
        for rel in files:
            path = fetch(rel)
            digest = sha256(path)
            if digest in seen:  # the source repo contains byte-identical copies; they would inflate genuine scores
                skipped.append((rel.split('/')[-1], 'duplicate file'))
                continue
            seen.add(digest)
            img = cv2.imread(path)
            if img is None:
                skipped.append((rel, 'unreadable'))
                continue
            img, faces = detect(det, img)
            if not faces:
                skipped.append((rel, 'no face detected'))
                continue
            face = max(faces, key=lambda f: f[2] * f[3])
            px = int(min(face[2], face[3]))
            samples.append((ident, rel, embed(rec, img, face), px, float(face[14]), float(yaw_ratio(face))))

    multi = []
    for rel in MULTI:
        img = cv2.imread(fetch(rel))
        img, faces = detect(det, img)
        multi.append((rel, len(faces)))

    genuine, impostor = [], []
    for a, b in itertools.combinations(samples, 2):
        s = float(np.dot(a[2], b[2]))
        (genuine if a[0] == b[0] else impostor).append((s, a[1], b[1]))

    def stats(xs):
        v = np.array([x[0] for x in xs])
        return dict(n=len(v), min=float(v.min()), p05=float(np.percentile(v, 5)), median=float(np.median(v)),
                    p95=float(np.percentile(v, 95)), max=float(v.max()))

    g, i = stats(genuine), stats(impostor)
    rows = []
    for t in (0.363, 0.40, 0.45, 0.50, 0.55):
        frr = sum(1 for s, *_ in genuine if s < t) / len(genuine)
        far = sum(1 for s, *_ in impostor if s >= t) / len(impostor)
        rows.append((t, frr, far))

    # 1:N identification with the kiosk rule (threshold 0.5 + margin 0.06), leave-one-out.
    ident_ok = ident_reject = ident_wrong = 0
    for k, probe in enumerate(samples):
        gallery = {}
        for j, s in enumerate(samples):
            if j == k:
                continue
            gallery.setdefault(s[0], []).append(s[2])
        scores = sorted(((max(float(np.dot(probe[2], v)) for v in vs), name) for name, vs in gallery.items()), reverse=True)
        best, second = scores[0], (scores[1] if len(scores) > 1 else (-1, None))
        has_genuine = probe[0] in gallery
        if best[0] >= 0.5 and best[0] - second[0] >= 0.06:
            if best[1] == probe[0]:
                ident_ok += 1
            else:
                ident_wrong += 1
        else:
            ident_reject += 1
        _ = has_genuine

    yaws = [s[5] for s in samples]
    lines = [
        '# Face pipeline sanity check — results',
        '',
        '_Generated by `tools/face-eval/eval.py`. Re-run to reproduce. This is NOT an accuracy benchmark._',
        '',
        f'- OpenCV: `{cv2.__version__}`; detector `face_detection_yunet_2023mar.onnx`; recognizer `face_recognition_sface_2021dec.onnx` (SHA-256 verified).',
        f'- Images: {len(samples)} single-person public photos of {len(SINGLE)} people (from the MIT-licensed `ageitgey/face_recognition` examples). Skipped: {len(skipped)} {skipped if skipped else ""}',
        f'- Face sizes (shorter side, px after resize to ≤640): min {min(s[3] for s in samples)}, median {int(np.median([s[3] for s in samples]))}.',
        '',
        '## Similarity distributions (cosine, higher = more similar)',
        '',
        '| Pairs | n | min | p5 | median | p95 | max |',
        '|---|---:|---:|---:|---:|---:|---:|',
        f"| Genuine (same person) | {g['n']} | {g['min']:.3f} | {g['p05']:.3f} | {g['median']:.3f} | {g['p95']:.3f} | {g['max']:.3f} |",
        f"| Impostor (different people) | {i['n']} | {i['min']:.3f} | {i['p05']:.3f} | {i['median']:.3f} | {i['p95']:.3f} | {i['max']:.3f} |",
        '',
        '## Verification error rates on this tiny set',
        '',
        '| Threshold | False reject rate | False accept rate |',
        '|---:|---:|---:|',
        *[f'| {t:.3f} | {frr:.1%} | {far:.1%} |' for t, frr, far in rows],
        '',
        '## 1:N identification with the kiosk rule (threshold 0.50, margin 0.06, leave-one-out)',
        '',
        f'- Correctly identified: {ident_ok}',
        f'- Rejected (asked to retry / use PIN): {ident_reject}',
        f'- **Wrong person accepted: {ident_wrong}**',
        '',
        '## Multi-face images (kiosk refuses to proceed when more than one face is in frame)',
        '',
        *[f'- `{rel.split("/")[-1]}`: {n} faces detected' for rel, n in multi],
        '',
        '## Head-turn liveness metric on frontal photos',
        '',
        f'- Yaw ratio (nose offset / eye distance) on these mostly-frontal photos: min {min(yaws):.2f}, median {np.median(yaws):.2f}, max {max(yaws):.2f}.',
        '  The kiosk challenge requires the ratio to move beyond ±0.18 to one side and return near centre.',
        '',
        '## Lowest genuine and highest impostor pairs',
        '',
        *[f'- genuine {s:.3f}: `{a.split("/")[-1]}` vs `{b.split("/")[-1]}`' for s, a, b in sorted(genuine)[:3]],
        *[f'- impostor {s:.3f}: `{a.split("/")[-1]}` vs `{b.split("/")[-1]}`' for s, a, b in sorted(impostor, reverse=True)[:3]],
        '',
        '## Interpretation and limits',
        '',
        '- These are well-lit public photos, mostly frontal, of a few people. Kiosk conditions (backlight, masks, caps, motion blur,',
        '  cheaper front cameras) are harder. Do not read these numbers as the production error rate.',
        '- Before go-live, run the on-site evaluation in docs/FACE_RECOGNITION.md with each employee and tune `match_threshold`.',
        '',
    ]
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w') as f:
        f.write('\n'.join(lines))
    print('\n'.join(lines))
    print(json.dumps({'genuine': g, 'impostor': i, 'identification': {'ok': ident_ok, 'reject': ident_reject, 'wrong': ident_wrong}}))


if __name__ == '__main__':
    main()
