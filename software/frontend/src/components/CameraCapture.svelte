<script lang="ts">
  // Take a photo with the device camera, or fall back to an image upload.
  // Emits a decoded HTMLImageElement via onCapture so the parent can turn it
  // into a sketch. Cameras aren't available everywhere (desktop, denied
  // permission, insecure origin) so upload is always offered too.
  import { onDestroy } from "svelte";
  import { loadImageFromFile } from "../lib/imageLineart";

  export let onCapture: (image: HTMLImageElement) => void;

  let videoElement: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;
  let cameraReady = false;
  let cameraError = "";

  async function startCamera(): Promise<void> {
    cameraError = "";
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraError = "This browser can't access a camera — upload an image instead.";
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      if (videoElement) {
        videoElement.srcObject = stream;
        await videoElement.play();
        cameraReady = true;
      }
    } catch (error) {
      cameraError = `Camera unavailable (${(error as Error).message}). Upload an image instead.`;
    }
  }

  function stopCamera(): void {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    cameraReady = false;
  }

  function capturePhoto(): void {
    if (!videoElement) return;
    const canvas = document.createElement("canvas");
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(videoElement, 0, 0);
    const image = new Image();
    image.onload = () => onCapture(image);
    image.src = canvas.toDataURL("image/jpeg", 0.92);
  }

  async function onFileChosen(eventTarget: EventTarget | null): Promise<void> {
    const file = (eventTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      onCapture(await loadImageFromFile(file));
    } catch (error) {
      cameraError = (error as Error).message;
    }
  }

  onDestroy(stopCamera);
</script>

<div class="capture">
  <div class="viewport" class:live={cameraReady}>
    <!-- svelte-ignore a11y-media-has-caption -->
    <video bind:this={videoElement} playsinline muted class:hidden={!cameraReady}></video>
    {#if !cameraReady}
      <span class="muted">Camera off</span>
    {/if}
  </div>

  <div class="controls">
    {#if cameraReady}
      <button class="primary" on:click={capturePhoto}>📸 Take photo</button>
      <button on:click={stopCamera}>Stop camera</button>
    {:else}
      <button on:click={startCamera}>Start camera</button>
    {/if}

    <label class="upload">
      <span>or upload an image</span>
      <input type="file" accept="image/*" on:change={(event) => onFileChosen(event.target)} />
    </label>
  </div>

  {#if cameraError}<p class="error small">{cameraError}</p>{/if}
</div>

<style>
  .viewport {
    background: #000;
    border-radius: var(--radius-small);
    border: 1px solid var(--border);
    min-height: 180px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  video {
    max-width: 100%;
    max-height: 320px;
    display: block;
  }

  video.hidden { display: none; }

  .controls {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
    margin-top: var(--space-2);
  }

  .upload {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: 0.85em;
    color: var(--text-dim);
  }

  .error { color: var(--danger); }
  .small { font-size: 0.85em; }
</style>
