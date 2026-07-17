<script lang="ts">
  // Interactive square crop / zoom / rotate editor, styled after a passport-photo
  // cropper. The user pans (drag), zooms (slider / wheel / pinch), and rotates a
  // photo inside a fixed square viewport; confirming renders the framed result to
  // a square canvas and emits it as an HTMLImageElement for the sketch pipeline.
  //
  // All geometry is stored resolution-independently: offsets are fractions of the
  // output side and the base scale re-derives per canvas size, so the on-screen
  // preview and the high-res export use identical math regardless of display size.
  import { onMount, onDestroy } from "svelte";
  import { detectFaceCrop } from "../lib/faceCrop";

  export let image: HTMLImageElement;
  export let onCropped: (cropped: HTMLImageElement) => void;
  export let onCancel: (() => void) | null = null;
  // Try to auto-frame the face when the editor opens. Off disables the model load.
  export let autoDetectFace = true;

  // Side length of the exported square, in pixels. High enough that the sketch
  // converter's luminance grid has detail to work with after cropping in.
  const EXPORT_SIZE_PX = 1000;
  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 5;

  let previewCanvas: HTMLCanvasElement;

  // Framing state. offsetX/Y are fractions of the output side (0 = centered);
  // rotationDeg is clockwise; zoom multiplies the cover-fit base scale.
  let zoom = 1;
  let rotationDeg = 0;
  let offsetXFraction = 0;
  let offsetYFraction = 0;

  // Active pointers for drag + pinch, keyed by pointerId.
  const activePointers = new Map<number, { x: number; y: number }>();
  let lastPinchDistance = 0;

  // Face auto-detect status, surfaced to the operator.
  type DetectStatus = "idle" | "detecting" | "found" | "failed";
  let detectStatus: DetectStatus = "idle";
  let detectMessage = "";

  /** Run face detection and snap the framing to center the face, if found. */
  async function autoFrameFace(): Promise<void> {
    detectStatus = "detecting";
    detectMessage = "Looking for a face…";
    try {
      const framing = await detectFaceCrop(image);
      zoom = clampZoom(framing.zoom);
      rotationDeg = framing.rotationDeg;
      offsetXFraction = framing.offsetXFraction;
      offsetYFraction = framing.offsetYFraction;
      detectStatus = "found";
      detectMessage = "Face found — adjust the framing if you like.";
    } catch (error) {
      detectStatus = "failed";
      detectMessage = (error as Error).message;
    }
  }

  /**
   * Draw the image into a square canvas with the current framing.
   *
   * @param canvas Target square canvas (its width/height define the side).
   */
  function renderTo(canvas: HTMLCanvasElement): void {
    const side = canvas.width;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, side, side);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, side, side);

    // Base scale that makes the un-zoomed image cover the square, so there's
    // never empty margin unless the user zooms out on purpose.
    const coverScale = Math.max(side / image.naturalWidth, side / image.naturalHeight);
    context.save();
    context.translate(side / 2 + offsetXFraction * side, side / 2 + offsetYFraction * side);
    context.rotate((rotationDeg * Math.PI) / 180);
    context.scale(coverScale * zoom, coverScale * zoom);
    context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
    context.restore();
  }

  function drawPreview(): void {
    if (previewCanvas) renderTo(previewCanvas);
  }

  // Redraw whenever any framing value changes.
  $: zoom, rotationDeg, offsetXFraction, offsetYFraction, drawPreview();

  function clampZoom(value: number): number {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    // Negative deltaY = scroll up = zoom in; scale by a small factor per notch.
    zoom = clampZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
  }

  function distanceBetweenPointers(): number {
    const points = [...activePointers.values()];
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  }

  function onPointerDown(event: PointerEvent): void {
    previewCanvas.setPointerCapture(event.pointerId);
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.size === 2) lastPinchDistance = distanceBetweenPointers();
  }

  function onPointerMove(event: PointerEvent): void {
    const previous = activePointers.get(event.pointerId);
    if (!previous) return;
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activePointers.size === 2) {
      // Two fingers → pinch-zoom relative to the change in finger spread.
      const distance = distanceBetweenPointers();
      if (lastPinchDistance > 0) zoom = clampZoom(zoom * (distance / lastPinchDistance));
      lastPinchDistance = distance;
      return;
    }

    // One finger / mouse → pan. Convert the display-pixel delta into a fraction
    // of the on-screen viewport so panning tracks the cursor at any size.
    const viewportSize = previewCanvas.getBoundingClientRect().width || 1;
    offsetXFraction += (event.clientX - previous.x) / viewportSize;
    offsetYFraction += (event.clientY - previous.y) / viewportSize;
  }

  function onPointerUp(event: PointerEvent): void {
    activePointers.delete(event.pointerId);
    if (activePointers.size < 2) lastPinchDistance = 0;
  }

  function rotateBy(degrees: number): void {
    rotationDeg = (rotationDeg + degrees) % 360;
  }

  function reset(): void {
    zoom = 1;
    rotationDeg = 0;
    offsetXFraction = 0;
    offsetYFraction = 0;
  }

  /** Render the framing at full export resolution and hand back an <img>. */
  function confirm(): void {
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = EXPORT_SIZE_PX;
    exportCanvas.height = EXPORT_SIZE_PX;
    renderTo(exportCanvas);
    const cropped = new Image();
    cropped.onload = () => onCropped(cropped);
    cropped.src = exportCanvas.toDataURL("image/jpeg", 0.92);
  }

  onMount(() => {
    drawPreview();
    if (autoDetectFace) autoFrameFace();
  });
  onDestroy(() => activePointers.clear());
</script>

<div class="cropper">
  <div class="stage">
    <canvas
      bind:this={previewCanvas}
      width="512"
      height="512"
      on:wheel={onWheel}
      on:pointerdown={onPointerDown}
      on:pointermove={onPointerMove}
      on:pointerup={onPointerUp}
      on:pointercancel={onPointerUp}
    ></canvas>
    <div class="frame-guide" aria-hidden="true"></div>
  </div>

  {#if detectStatus !== "idle"}
    <p class="detect" class:err={detectStatus === "failed"} class:ok={detectStatus === "found"}>
      {#if detectStatus === "detecting"}<span class="dot" aria-hidden="true"></span>{/if}
      {detectMessage}
    </p>
  {/if}

  <p class="hint muted">Drag to move • scroll or pinch to zoom • sliders to fine-tune</p>

  <label class="field">
    <span>Zoom ({zoom.toFixed(2)}×)</span>
    <input type="range" min={MIN_ZOOM} max={MAX_ZOOM} step="0.01" bind:value={zoom} />
  </label>

  <label class="field">
    <span>Rotate ({Math.round(rotationDeg)}°)</span>
    <input type="range" min="-180" max="180" step="1" bind:value={rotationDeg} />
  </label>

  <div class="actions">
    <button type="button" on:click={() => rotateBy(-90)}>⟲ 90°</button>
    <button type="button" on:click={() => rotateBy(90)}>⟳ 90°</button>
    <button type="button" on:click={reset}>Reset</button>
    {#if autoDetectFace}
      <button type="button" on:click={autoFrameFace} disabled={detectStatus === "detecting"}>
        🙂 Center on face
      </button>
    {/if}
    {#if onCancel}
      <button type="button" on:click={onCancel}>Cancel</button>
    {/if}
    <button type="button" class="primary" on:click={confirm}>Use this crop</button>
  </div>
</div>

<style>
  .stage {
    position: relative;
    width: 100%;
    max-width: 360px;
    margin: 0 auto;
    aspect-ratio: 1 / 1;
    background: #000;
    border-radius: var(--radius-small);
    border: 1px solid var(--border);
    overflow: hidden;
  }

  canvas {
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none; /* let pointer handlers own drag/pinch gestures */
    cursor: grab;
  }

  canvas:active { cursor: grabbing; }

  /* Non-interactive rule-of-thirds overlay to help the operator frame a face. */
  .frame-guide {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image:
      linear-gradient(to right, rgba(255, 255, 255, 0.35) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(255, 255, 255, 0.35) 1px, transparent 1px);
    background-size: 33.33% 33.33%;
    background-position: -1px -1px;
  }

  .hint { font-size: 0.85em; text-align: center; margin: var(--space-2) 0; }

  .detect {
    font-size: 0.85em;
    text-align: center;
    margin: var(--space-2) 0 0;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
  }
  .detect.ok { color: var(--ok); }
  .detect.err { color: var(--danger); }

  /* Small spinner shown while the model loads / runs. */
  .dot {
    width: 0.7em;
    height: 0.7em;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-bottom: var(--space-2);
  }

  .field span { color: var(--text-dim); font-size: 0.9em; }

  .actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-top: var(--space-2);
  }

  .actions .primary { margin-left: auto; }
</style>
