<script lang="ts">
  // CNC-style interactive paper view: the sheet, the printable margin, the live
  // pen-head position, and the drawing itself (real preview art) which the admin
  // can drag to reposition and resize with the corner handle. All geometry is in
  // the operator's view (mm, Y-down) so it matches how the paper looks on the bed.
  import type { Job, LayoutPatch } from "../lib/api";

  export let job: Job;
  /** Live pen position in machine mm, or null when disconnected. */
  export let penXMm: number | null = null;
  export let penYMm: number | null = null;
  /**
   * Live X-axis mounting from the machine config (status.paper.mirrorX) — drives
   * the pen-marker reflection. Kept separate from the job's baked-in layout.mirrorX
   * so the live pen tracks the machine even if the job predates a config change.
   */
  export let mirrorX = false;
  export let editable = true;
  /** Called with an explicit placement patch when a drag/resize commits. */
  export let onChange: (patch: LayoutPatch) => void;

  let svgEl: SVGSVGElement;

  // Local, optimistic placement state — mirrors the server layout but updates
  // live during a drag. Re-synced from the job whenever it changes (not mid-drag).
  let posX = 0;
  let posY = 0;
  let fill = 1;
  let drag: { kind: "move" | "resize"; startX: number; startY: number; baseX: number; baseY: number; baseFill: number } | null = null;

  $: layout = job.layout;
  // Full-fit content size (what the drawing would be at fillFraction = 1).
  $: fullWidth = layout ? layout.contentWidthMm / layout.fillFraction : 0;
  $: fullHeight = layout ? layout.contentHeightMm / layout.fillFraction : 0;
  $: contentWidth = fullWidth * fill;
  $: contentHeight = fullHeight * fill;

  // Sync local state from the server layout when we're not actively dragging.
  $: if (layout && !drag) {
    posX = layout.positionXMm;
    posY = layout.positionYMm;
    fill = layout.fillFraction;
  }

  // Overflow is derived live so the warning reacts while dragging, before commit.
  $: overflowing = !!layout && (
    posX < layout.paddingMm - 0.01 ||
    posY < layout.paddingMm - 0.01 ||
    posX + contentWidth > layout.paperWidthMm - layout.paddingMm + 0.01 ||
    posY + contentHeight > layout.paperHeightMm - layout.paddingMm + 0.01
  );

  // Live pen head in operator-view mm (inverse of the placement reflection).
  // Uses the live machine mounting (mirrorX prop), not the job's baked value.
  $: penView = layout && penXMm != null && penYMm != null
    ? {
        x: mirrorX ? layout.paperWidthMm - layout.paddingMm - penXMm : layout.paddingMm + penXMm,
        y: layout.paperHeightMm - layout.paddingMm - penYMm,
      }
    : null;

  function clientToMm(event: PointerEvent): { x: number; y: number } {
    const point = svgEl.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const transformed = point.matrixTransform(svgEl.getScreenCTM()!.inverse());
    return { x: transformed.x, y: transformed.y };
  }

  function startDrag(kind: "move" | "resize", event: PointerEvent): void {
    if (!editable || !layout) return;
    event.preventDefault();
    const mm = clientToMm(event);
    drag = { kind, startX: mm.x, startY: mm.y, baseX: posX, baseY: posY, baseFill: fill };
    (event.target as Element).setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent): void {
    if (!drag || !layout) return;
    const mm = clientToMm(event);
    if (drag.kind === "move") {
      posX = drag.baseX + (mm.x - drag.startX);
      posY = drag.baseY + (mm.y - drag.startY);
    } else {
      // Resize from the bottom-right handle, keeping the top-left corner fixed.
      const newWidth = Math.max(fullWidth * 0.02, mm.x - posX);
      fill = Math.max(0.02, Math.min(1, newWidth / fullWidth));
    }
  }

  function endDrag(event: PointerEvent): void {
    if (!drag) return;
    (event.target as Element).releasePointerCapture?.(event.pointerId);
    const kind = drag.kind;
    drag = null;
    if (kind === "move") onChange({ positionXMm: posX, positionYMm: posY });
    else onChange({ fillFraction: fill, positionXMm: posX, positionYMm: posY });
  }

  const round = (value: number) => Math.round(value * 10) / 10;
</script>

{#if layout}
  <div class="wrap">
    <svg
      bind:this={svgEl}
      viewBox={`0 0 ${layout.paperWidthMm} ${layout.paperHeightMm}`}
      preserveAspectRatio="xMidYMid meet"
      class:editable
      on:pointermove={moveDrag}
      on:pointerup={endDrag}
      on:pointercancel={endDrag}
      role="application"
      aria-label="Paper layout — drag to position the drawing"
    >
      <!-- Sheet -->
      <rect class="sheet" x="0" y="0" width={layout.paperWidthMm} height={layout.paperHeightMm} />
      <!-- Printable margin -->
      <rect
        class="margin"
        x={layout.paddingMm} y={layout.paddingMm}
        width={layout.drawableWidthMm} height={layout.drawableHeightMm}
        stroke-dasharray="3 2"
      />

      <!-- Drawing (real preview art), draggable -->
      <g
        class="drawing"
        class:overflowing
        class:editable
        role="button"
        tabindex="0"
        aria-label="Drawing — drag to reposition on the paper"
        on:pointerdown={(event) => startDrag("move", event)}
      >
        <image
          href={`/api/jobs/${job.id}/preview.svg`}
          x={posX} y={posY} width={contentWidth} height={contentHeight}
          preserveAspectRatio="none"
          opacity="0.92"
        />
        <rect class="bbox" x={posX} y={posY} width={contentWidth} height={contentHeight} />
      </g>

      <!-- Resize handle (bottom-right corner of the drawing box) -->
      {#if editable}
        <rect
          class="handle"
          role="button"
          tabindex="0"
          aria-label="Resize the drawing"
          x={posX + contentWidth - layout.paperWidthMm * 0.018}
          y={posY + contentHeight - layout.paperWidthMm * 0.018}
          width={layout.paperWidthMm * 0.036}
          height={layout.paperWidthMm * 0.036}
          on:pointerdown={(event) => startDrag("resize", event)}
        />
      {/if}

      <!-- Live pen head -->
      {#if penView}
        <g class="pen">
          <circle cx={penView.x} cy={penView.y} r={layout.paperWidthMm * 0.02} />
          <line x1={penView.x - layout.paperWidthMm * 0.05} y1={penView.y} x2={penView.x + layout.paperWidthMm * 0.05} y2={penView.y} />
          <line x1={penView.x} y1={penView.y - layout.paperWidthMm * 0.05} x2={penView.x} y2={penView.y + layout.paperWidthMm * 0.05} />
        </g>
      {/if}
    </svg>

    <div class="legend">
      <span class="tag">{layout.orientation}</span>
      <span class="muted">{round(contentWidth)} × {round(contentHeight)} mm · {Math.round(fill * 100)}%</span>
      {#if penView}<span class="pen-key">✛ pen</span>{/if}
      {#if overflowing}<span class="warn-key">⚠ extends past the {round(layout.paddingMm)} mm margin</span>{/if}
    </div>
  </div>
{/if}

<style>
  .wrap { display: flex; flex-direction: column; gap: var(--space-2); }

  svg {
    width: 100%;
    height: auto;
    max-height: 52vh;
    background: var(--bg-inset);
    border-radius: var(--radius-small);
    touch-action: none;
  }

  .sheet { fill: #fff; stroke: var(--border); stroke-width: 0.5; }
  .margin { fill: none; stroke: #b9c0cc; stroke-width: 0.4; }

  .drawing.editable { cursor: grab; }
  .drawing.editable:active { cursor: grabbing; }
  .bbox { fill: none; stroke: var(--accent); stroke-width: 0.4; }
  .drawing.overflowing .bbox { stroke: var(--danger); stroke-width: 0.6; }

  .handle {
    fill: var(--accent);
    stroke: #fff;
    stroke-width: 0.3;
    cursor: nwse-resize;
  }

  .pen circle { fill: color-mix(in srgb, var(--ok) 30%, transparent); stroke: var(--ok); stroke-width: 0.4; }
  .pen line { stroke: var(--ok); stroke-width: 0.4; }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    font-size: 0.82em;
  }

  .tag {
    text-transform: capitalize;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px var(--space-2);
    color: var(--text-dim);
  }

  .pen-key { color: var(--ok); }
  .warn-key { color: var(--danger); }
</style>
