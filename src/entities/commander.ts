/**
 * COMMANDER OVERKILL — the thing your thumb is actually steering.
 *
 * The mesh does NOT snap to the input. Raw input on a phone is jittery and a
 * hard-locked avatar reads as cheap; a critically-damped follow gives weight
 * without adding perceptible latency. The lean is doing the same job as the
 * squash in a platformer — it tells you the turn registered before the
 * position visibly changes.
 */

import * as THREE from "three";
import { laneToX } from "../mechanics/lane";

/** Higher converges faster. 12 is roughly two frames of visible lag at 60Hz. */
const FOLLOW = 12;
const MAX_LEAN = 0.42;

export class Commander {
  readonly object = new THREE.Group();

  /** Sim-space lane, [-1, 1]. Lags the raw input target. */
  lane = 0;
  #prevLane = 0;
  #velocity = 0;

  constructor() {
    // Placeholder primitives. The .glb drops in behind this same interface.
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.34, 0.62, 4, 12),
      new THREE.MeshLambertMaterial({ color: 0x3f8f4f }),
    );
    body.position.y = 0.72;
    this.object.add(body);

    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.29, 14, 10),
      new THREE.MeshLambertMaterial({ color: 0x2f6b3c }),
    );
    helmet.position.y = 1.36;
    this.object.add(helmet);

    // A bright flash so he never disappears against the road at distance.
    const scarf = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 0.14, 0.16),
      new THREE.MeshLambertMaterial({ color: 0xffc93c }),
    );
    scarf.position.set(0, 1.06, 0.12);
    this.object.add(scarf);
  }

  /** Advance one fixed sim step toward the steering target. */
  update(dt: number, target: number): void {
    this.#prevLane = this.lane;
    const next = this.lane + (target - this.lane) * Math.min(1, FOLLOW * dt);
    this.#velocity = (next - this.lane) / dt;
    this.lane = next;
  }

  /** Draw between the last two sim states so motion is smooth off-cadence. */
  render(alpha: number): void {
    const shown = this.#prevLane + (this.lane - this.#prevLane) * alpha;
    this.object.position.x = laneToX(shown);
    this.object.rotation.z = clampLean(-this.#velocity * 0.16);
  }
}

function clampLean(v: number): number {
  return v < -MAX_LEAN ? -MAX_LEAN : v > MAX_LEAN ? MAX_LEAN : v;
}
