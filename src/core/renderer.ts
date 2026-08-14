/**
 * RENDERER BOOTSTRAP — canvas, camera, lights, and the resize policy.
 *
 * THE DPR CAP IS THE WHOLE PERFORMANCE STORY ON PHONES. A modern handset
 * reports devicePixelRatio 3, which is 9× the pixels of DPR 1 for a display
 * you hold at arm's length. Capping at 2 is invisible to the eye and buys back
 * roughly half the fill rate — the single cheapest 60fps decision available.
 */

import * as THREE from "three";

/** Portrait framing: the corridor runs away from the player down -Z. */
export const CAMERA_POS = new THREE.Vector3(0, 7.5, 9.5);
export const CAMERA_LOOK = new THREE.Vector3(0, 0, -9);

const MAX_DPR = 2;

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  resize: () => void;
}

/**
 * Sky and haze, one colour.
 *
 * They MUST match: the fog fades distant geometry toward this, so any difference
 * shows up as a hard line where the corridor ends. Deepened slightly from the
 * original `0x7cc4e8` now that the world below it is a dark blue channel rather
 * than green grass — the old sky read as washed out against the water.
 */
const SKY_COLOR = 0x6fbde4;

export function createStage(canvas: HTMLCanvasElement): Stage {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(SKY_COLOR);

  const scene = new THREE.Scene();
  // Fog hides the corridor's far end so we never have to draw geometry that is
  // about to be culled anyway, and it reads as bright haze rather than a void.
  //
  // The far plane must sit BEYOND the spawn distance. Content spawns at z=-58,
  // which is ~67m from this camera; the first cut faded out at 62, so barrels
  // and gates were fully hazed before the player ever saw them — you cannot
  // plan a route through a decision you cannot read. The reference keeps
  // distant barrels crisp and hazes only the horizon.
  scene.fog = new THREE.Fog(SKY_COLOR, 62, 105);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
  camera.position.copy(CAMERA_POS);
  camera.lookAt(CAMERA_LOOK);

  // Two lights, no shadow maps. Shadows are the second thing that kills a
  // mobile frame budget; the cartoon look does not need them.
  //
  // THE KEY LIGHT IS UP-SCREEN FOR A REASON. Every element draws its own fake
  // contact shadow, and a shadow's direction is the opposite of the light's. A
  // light on the camera side (the flattering choice, and where this started)
  // throws every shadow up-screen — directly BEHIND the unit casting it, where
  // it is hidden. The shadows are what seat units on the road, so losing them
  // makes the whole crowd hover.
  //
  // Placing the key up-screen-left throws shadows down-screen-right, which is
  // both visible and what the reference frames show. Backlighting is paid for
  // by the strong hemisphere fill below.
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(-4, 10, -6);
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0xcfefff, 0x4a7a3a, 1.5));

  const resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize);
  // iOS fires resize before the URL bar finishes collapsing; orientation needs
  // a second pass or the canvas is short by the bar's height for one frame.
  window.addEventListener("orientationchange", () => setTimeout(resize, 100));

  return { renderer, scene, camera, resize };
}
