/**
 * LANE MANAGER — the corridor's geometry, and the one place that owns the
 * mapping from "normalised steering input" to "world X".
 *
 * Everything that needs to know how wide the road is asks here. When the
 * corridor widens for a boss arena, it widens in one file.
 */

import * as THREE from "three";

export const CORRIDOR_HALF_WIDTH = 3.4;
/** How far down -Z the road is drawn. Beyond this the fog has taken over anyway. */
export const CORRIDOR_LENGTH = 70;

/** Normalised lane [-1, 1] → world X. */
export function laneToX(lane: number): number {
  return lane * CORRIDOR_HALF_WIDTH;
}

/**
 * The road surface, as a procedural canvas texture rather than an asset.
 * Per the asset protocol: primitives and generated textures first, so we know
 * the frame budget holds before any .glb lands in the project.
 */
export function createCorridor(): THREE.Group {
  const group = new THREE.Group();

  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(CORRIDOR_HALF_WIDTH * 2, CORRIDOR_LENGTH),
    new THREE.MeshLambertMaterial({ map: roadTexture() }),
  );
  road.rotation.x = -Math.PI / 2;
  road.position.z = -CORRIDOR_LENGTH / 2 + 8;
  group.add(road);

  // Grass shoulders, wide enough to fill the frame at every aspect ratio we
  // support. Flat colour — they are peripheral vision, not scenery.
  const shoulder = new THREE.MeshLambertMaterial({ color: 0x6ab04c });
  for (const side of [-1, 1]) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(18, CORRIDOR_LENGTH), shoulder);
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(side * (CORRIDOR_HALF_WIDTH + 9), -0.02, road.position.z);
    group.add(strip);
  }

  // Kerbs: the player needs an unambiguous read on where the wall is, because
  // steering into it is how you miss a gate.
  const kerbMat = new THREE.MeshLambertMaterial({ color: 0xf5f0e1 });
  for (const side of [-1, 1]) {
    const kerb = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.4, CORRIDOR_LENGTH), kerbMat);
    kerb.position.set(side * CORRIDOR_HALF_WIDTH, 0.18, road.position.z);
    group.add(kerb);
  }

  return group;
}

function roadTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 128;
  const ctx = c.getContext("2d")!;

  ctx.fillStyle = "#8d8f96";
  ctx.fillRect(0, 0, 64, 128);
  // One dashed centre stripe per tile; the tile repeats down the corridor and
  // the motion of the dashes is what sells forward speed later.
  ctx.fillStyle = "#e8e4d8";
  ctx.fillRect(29, 12, 6, 44);
  ctx.fillRect(29, 72, 6, 44);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, CORRIDOR_LENGTH / 6);
  tex.anisotropy = 4;
  return tex;
}
