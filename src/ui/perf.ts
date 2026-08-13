/**
 * PERF OVERLAY — opt-in via `?perf`.
 *
 * The one number that matters is frame time on a real phone, not fps on a
 * desktop. Draw calls are here too because that is the figure that will move
 * once instanced crowds land in 1.2b.
 */

import { bus } from "../core/events";
import type * as THREE from "three";

export function mountPerfOverlay(host: HTMLElement, renderer: THREE.WebGLRenderer): void {
  if (!new URLSearchParams(location.search).has("perf")) return;

  const el = document.createElement("div");
  el.className = "perf";
  el.textContent = "…";
  host.appendChild(el);

  bus.on("frame:stats", ({ fps, frameMs, simMs }) => {
    const { calls, triangles } = renderer.info.render;
    el.textContent =
      `${fps.toFixed(0)} fps  ${frameMs.toFixed(1)} ms\n` +
      `sim ${simMs.toFixed(2)} ms\n` +
      `${calls} calls  ${(triangles / 1000).toFixed(1)}k tris\n` +
      `dpr ${renderer.getPixelRatio().toFixed(1)}`;
  });
}
