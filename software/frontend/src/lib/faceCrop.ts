// Optional face-detection auto-framing for the photo cropper. Loads TensorFlow.js
// + the MediaPipe FaceMesh model lazily from a CDN the first time it's needed, then
// turns a detected face into framing parameters (zoom + pan) for ImageCropper.
//
// The whole module fails soft: if the CDN is unreachable (offline plotter) or the
// model can't run, `detectFaceCrop` throws and the caller keeps manual cropping.
// Nothing here is required for the page to work — it only pre-frames the crop.

// Global handles attached by the two CDN scripts (see loadScript URLs below). The
// packages have no bundled types here, so we describe just what we call.
declare global {
  interface Window {
    tf: any;
    faceLandmarksDetection: any;
  }
}

const TFJS_URL = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.0.0/dist/tf.min.js";
const FACE_MODEL_URL =
  "https://cdn.jsdelivr.net/npm/@tensorflow-models/face-landmarks-detection@1.0.2/dist/face-landmarks-detection.min.js";

/** A square crop expressed in the source image's pixel space. */
interface CropSquare {
  centerX: number;
  centerY: number;
  size: number;
}

/** Framing values ImageCropper understands (see its `renderTo` geometry). */
export interface FaceFraming {
  zoom: number;
  offsetXFraction: number;
  offsetYFraction: number;
  /** Clockwise degrees to rotate the image so the eyes sit level. */
  rotationDeg: number;
}

// Canonical MediaPipe FaceMesh (468-point) eye-corner indices, used to measure
// head roll. 33/133 = outer/inner corners of the image-left eye; 263/362 =
// outer/inner corners of the image-right eye.
const EYE_LANDMARKS = { leftOuter: 33, leftInner: 133, rightOuter: 263, rightInner: 362 };
// Don't trust a leveling correction beyond this — a larger angle usually means a
// misdetection or a genuine profile shot, where auto-rotating looks worse.
const MAX_LEVEL_DEG = 40;

// FaceMesh reports only the visible face, not the full head. Divide the detected
// height by this to estimate the true head height (foreheads/hair sit above the
// landmarks), matching the passport-reference compensation.
const FACE_TO_HEAD_RATIO = 0.75;
// Fraction of the crop the head should occupy vertically — a portrait look with
// breathing room around the head.
const HEAD_FILL_FRACTION = 0.62;
// Share of the leftover space placed above the head (rest goes below the chin).
const HEADROOM_ABOVE_FRACTION = 0.3;

// Cache the (slow) model load so repeated crops reuse one detector.
let detectorPromise: Promise<any> | null = null;

/** Inject a CDN script once and resolve when it has executed. */
function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${url}"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load face-detection script: ${url}`));
    document.head.appendChild(script);
  });
}

/**
 * Create the FaceMesh detector on whichever TF.js backend works. WebGL is tried
 * first for speed; if its shaders won't compile (some browsers/GPUs) we fall back
 * to the slower CPU backend, which runs everywhere. `refineLandmarks` stays off —
 * we only need a bounding box, not the dense attention mesh.
 */
async function createDetector(): Promise<any> {
  const tf = window.tf;
  const models = window.faceLandmarksDetection;
  try {
    tf.env().set("WEBGL_PACK", false); // avoids a broken packed-shader path on some GPUs
    await tf.setBackend("webgl");
    await tf.ready();
  } catch (webglError) {
    console.warn("WebGL backend unusable for face detection, using CPU:", webglError);
    await tf.setBackend("cpu");
    await tf.ready();
  }
  return models.createDetector(models.SupportedModels.MediaPipeFaceMesh, {
    runtime: "tfjs",
    maxFaces: 1,
    refineLandmarks: false,
  });
}

/** Lazily load the CDN scripts + model, caching the detector for reuse. */
function loadDetector(): Promise<any> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      await loadScript(TFJS_URL);
      await loadScript(FACE_MODEL_URL);
      return createDetector();
    })().catch((error) => {
      detectorPromise = null; // let a later attempt retry after a transient failure
      throw error;
    });
  }
  return detectorPromise;
}

/** Axis-aligned bounding box of a keypoint cloud. */
function boundingBox(keypoints: { x: number; y: number }[]): {
  minX: number;
  minY: number;
  width: number;
  height: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of keypoints) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Turn a detected face box into a square crop: estimate the full head, size the
 * crop so the head fills `HEAD_FILL_FRACTION`, and bias the head toward the top.
 * Clamped to the image so the crop never demands pixels that don't exist.
 */
function cropFromFace(
  face: { minX: number; minY: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number,
): CropSquare {
  const headHeight = face.height / FACE_TO_HEAD_RATIO;
  const headTopY = face.minY - (headHeight - face.height);
  const faceCenterX = face.minX + face.width / 2;

  // Never zoom out past "cover", so cap the crop at the shorter image side.
  const size = Math.min(headHeight / HEAD_FILL_FRACTION, Math.min(imageWidth, imageHeight));
  const freeSpace = size - headHeight;
  const cropTopY = headTopY - freeSpace * HEADROOM_ABOVE_FRACTION;

  return { centerX: faceCenterX, centerY: cropTopY + size / 2, size };
}

/**
 * Roll angle of the head, in clockwise degrees, from the line between the two
 * eye centers. Returns 0 if the eye landmarks are missing or the angle is beyond
 * `MAX_LEVEL_DEG` (likely a bad detection). ImageCropper rotates by this to level.
 */
function eyeLevelingDegrees(keypoints: { x: number; y: number }[]): number {
  const points = Object.values(EYE_LANDMARKS).map((index) => keypoints[index]);
  if (points.some((point) => !point)) return 0;

  const [leftOuter, leftInner, rightOuter, rightInner] = points;
  const leftEyeX = (leftOuter.x + leftInner.x) / 2;
  const leftEyeY = (leftOuter.y + leftInner.y) / 2;
  const rightEyeX = (rightOuter.x + rightInner.x) / 2;
  const rightEyeY = (rightOuter.y + rightInner.y) / 2;

  // Positive when the image-right eye sits lower than the left; rotating the
  // image by the negative of that angle brings the eye line back to horizontal.
  const rollDeg = (Math.atan2(rightEyeY - leftEyeY, rightEyeX - leftEyeX) * 180) / Math.PI;
  const levelDeg = -rollDeg;
  return Math.abs(levelDeg) > MAX_LEVEL_DEG ? 0 : levelDeg;
}

/**
 * Convert an image-space crop square into ImageCropper framing. Derivation: with
 * cover-scale = S/min(iw,ih), a crop of side C mapped to fill the square needs
 * draw-scale S/C, so zoom = min(iw,ih)/C. The face-center offset is rotated by
 * the same angle ImageCropper will apply so the face stays centered under the
 * rotation (its `renderTo` rotates about the offset point). See renderTo for the
 * forward mapping.
 */
function framingFromCrop(
  crop: CropSquare,
  imageWidth: number,
  imageHeight: number,
  rotationDeg: number,
): FaceFraming {
  const shorterSide = Math.min(imageWidth, imageHeight);
  const centerOffsetX = crop.centerX - imageWidth / 2;
  const centerOffsetY = crop.centerY - imageHeight / 2;

  const rotationRad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);
  const rotatedX = centerOffsetX * cos - centerOffsetY * sin;
  const rotatedY = centerOffsetX * sin + centerOffsetY * cos;

  return {
    zoom: shorterSide / crop.size,
    offsetXFraction: -rotatedX / crop.size,
    offsetYFraction: -rotatedY / crop.size,
    rotationDeg,
  };
}

/**
 * Detect the single face in an image and return framing that centers it, or throw
 * if the model is unavailable or no usable single face is found.
 *
 * @param image A fully-decoded, canvas-drawable image element.
 * @returns Framing (zoom + pan offsets) for ImageCropper.
 */
export async function detectFaceCrop(image: HTMLImageElement): Promise<FaceFraming> {
  const detector = await loadDetector();
  // staticImageMode: true runs full detection on a lone still; the default
  // video/tracking mode often returns nothing for a single frame.
  const faces = await detector.estimateFaces(image, {
    flipHorizontal: false,
    staticImageMode: true,
  });
  if (faces.length === 0) throw new Error("No face detected — frame the photo manually.");
  if (faces.length > 1) throw new Error("Multiple faces detected — frame the photo manually.");

  const keypoints = faces[0].keypoints;
  const box = boundingBox(keypoints);
  if (box.width <= 0 || box.height <= 0) {
    throw new Error("Face detection was inconclusive — frame the photo manually.");
  }
  const crop = cropFromFace(box, image.naturalWidth, image.naturalHeight);
  const rotationDeg = eyeLevelingDegrees(keypoints);
  return framingFromCrop(crop, image.naturalWidth, image.naturalHeight, rotationDeg);
}
