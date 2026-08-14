/**
 * STEPPED CAMERA ZOOM — how a crowd keeps growing after it has run out of road.
 *
 * The crowd widens until it spans the road and deepens until the rear rank
 * reaches the bottom of the frame. Both of those are hard walls at a fixed
 * camera, and past them "you got 200 more troops" stops being visible at all,
 * which is the one thing the growth beat cannot afford.
 *
 * So the camera steps back. Not continuously — in DISCRETE, NAMED steps tied to
 * troop counts, because a camera that drifts every time a `+1` lands reads as
 * drift, and because a step that happens on the growth beat reads as the reward
 * getting bigger. The steps are below, and they are the whole configuration.
 *
 * ---------------------------------------------------------------------------
 * THE CAMERA DOLLIES ALONG ITS OWN VIEW AXIS. THIS IS LOAD-BEARING.
 * ---------------------------------------------------------------------------
 * `mechanics/bullets.ts` bakes a billboard basis at module load,
 * `ui/floaters.ts` bakes a screen-plane basis, and `entities/squad.ts` derives
 * its shadow and containment maths — all of them from CAMERA_POS/CAMERA_LOOK,
 * all of them once, on the assumption that the camera never moves.
 *
 * Moving the camera straight back along the axis it already points down keeps
 * that assumption true where it matters: the view DIRECTION is unchanged, so
 * every one of those bases is still correct. Only the scale changes. Orbit the
 * camera instead — raise it, tilt it, slide it sideways — and all three modules
 * silently render against a camera that no longer exists.
 *
 * THE LATERAL PAN OBEYS THE SAME RULE, and it is worth being precise about why
 * it is allowed. Sliding the camera sideways while the look-at point stays put
 * would ROTATE it, which is exactly the case the paragraph above forbids. This
 * module moves the camera and its look-at point together by the same vector, so
 * what happens is a pure TRANSLATION: every axis of the view basis is untouched,
 * and every module that baked one is still correct. Keep it that way — the pan
 * and the target must always move as a pair.
 */

import * as THREE from "three";
import { CAMERA_LOOK, CAMERA_POS } from "./renderer";

/**
 * Troop count → how far back the camera sits, as a multiple of its resting
 * distance from the look-at point.
 *
 * The first step is at 120 because that is where the crowd stops growing: the
 * half-width cap (~2.57, the road) is reached at ~80 and the depth cap at the
 * old framing shortly after, so past ~120 extra troops only pack in tighter.
 * Steps are ~20% apart, which is enough to read as "the shot pulled back" and
 * small enough that the units do not visibly shrink in one jump.
 */
export const ZOOM_STEPS: readonly (readonly [troops: number, distance: number])[] = [
  [0, 1.0],
  [120, 1.2],
  [250, 1.45],
  [450, 1.7],
  [800, 2.0],
];

/**
 * Fraction of a step's threshold the count must fall back below before the
 * camera comes in again.
 *
 * WITHOUT THIS THE CAMERA JITTERS. A squad sitting at exactly 120 that gains
 * and loses a troop every gate would pump the camera in and out once a second.
 * 0.85 means the step out happens at 120 and the step back in at 102, so the
 * only way to see it move twice is to actually cross a 15% band of army.
 */
const HYSTERESIS = 0.85;

/** Seconds to ease between two steps. Fast enough to belong to the growth beat
 *  that triggered it, slow enough not to read as a cut. */
const EASE_TIME = 0.45;

/**
 * Share of the crowd's offset from the centreline that the camera matches.
 *
 * NOT 1. A camera that tracks the crowd exactly pins it to the middle of the
 * frame, and then steering produces no visible movement of the thing you are
 * steering — only the world sliding past, which reads as the road moving rather
 * than as you moving. At 0.78 the crowd still travels visibly within the frame
 * while the camera brings the far kerb into view ahead of it, which is the whole
 * reason the pan exists: an 11.2 m road is wider than the screen at the player's
 * own depth, so without this, half of what you may steer to is off-screen.
 */
const PAN_GAIN = 0.78;
/** First-order follow rate for the pan, in 1/seconds. Deliberately slower than
 *  the crowd's own steering (see LATERAL_SPEED in entities/squad.ts) so the
 *  camera trails a hard turn and lets the crowd lead it. */
const PAN_FOLLOW = 5.5;

/** Resting distance from CAMERA_POS to CAMERA_LOOK — the unit the steps scale. */
const REST_DISTANCE = CAMERA_POS.distanceTo(CAMERA_LOOK);

/** Unit vector from the look-at point back toward the camera. Dollying is this
 *  scaled; see the note at the top about why it must be exactly this. */
const VIEW_AXIS = new THREE.Vector3().subVectors(CAMERA_POS, CAMERA_LOOK).normalize();

export interface ZoomController {
  /** Multiple of the resting distance the camera is currently at. */
  readonly distance: number;
  /** The step the troop count alone would put it at, ignoring the ease. */
  readonly target: number;
  /** World X the camera has panned to. Read for diagnostics; never written. */
  readonly panX: number;
  /**
   * Advance the ease and write the camera's position and fog. Call once per
   * tick, after the troop count for this tick is final. `centerX` is the crowd's
   * world X — the pan target, scaled by PAN_GAIN.
   */
  update(dt: number, troops: number, centerX: number): void;
  /** Snap to the step for `troops` with no ease, centred. For a run restart. */
  reset(troops: number): void;
}

/**
 * Which step a count sits at, given where it is now.
 *
 * `current` is what makes this hysteretic rather than a lookup: stepping OUT
 * uses the raw threshold, stepping IN requires falling to HYSTERESIS of it.
 */
export function stepFor(troops: number, current: number): number {
  let out = ZOOM_STEPS[0]![1];
  for (const [threshold, distance] of ZOOM_STEPS) {
    // Already at or beyond this step: hold it until the count drops through the
    // hysteresis band under its threshold.
    const entering = troops >= threshold;
    const holding = distance <= current && troops >= threshold * HYSTERESIS;
    if (entering || holding) out = Math.max(out, distance);
  }
  return out;
}

export function createZoom(camera: THREE.PerspectiveCamera, scene: THREE.Scene): ZoomController {
  // Captured before anything moves, so a reset is exact rather than cumulative.
  const fog = scene.fog as THREE.Fog | null;
  const fogNear = fog ? fog.near : 0;
  const fogFar = fog ? fog.far : 0;

  let distance = 1;
  let target = 1;
  let panX = 0;
  /** Scratch for the panned look-at point, so apply() never allocates. */
  const lookAt = new THREE.Vector3();

  function apply(): void {
    lookAt.copy(CAMERA_LOOK);
    lookAt.x += panX;
    camera.position.copy(lookAt).addScaledVector(VIEW_AXIS, REST_DISTANCE * distance);
    // Position and target move by the same vector, so this is a translation and
    // the view basis is unchanged — see the note at the top of the file.
    camera.lookAt(lookAt);
    // Fog is measured from the camera, so pulling back would haze content that
    // was crisp a moment ago — and a barrel you cannot read is a decision you
    // cannot plan. Push the band back by exactly what the camera gained.
    if (fog) {
      const gained = REST_DISTANCE * (distance - 1);
      fog.near = fogNear + gained;
      fog.far = fogFar + gained;
    }
  }

  apply();

  return {
    get distance() {
      return distance;
    },
    get target() {
      return target;
    },
    get panX() {
      return panX;
    },

    update(dt, troops, centerX) {
      target = stepFor(troops, target);
      const wantPan = centerX * PAN_GAIN;
      const nextPan = panX + (wantPan - panX) * Math.min(1, PAN_FOLLOW * dt);
      const moved = Math.abs(nextPan - panX) > 1e-5;
      panX = nextPan;
      if (distance === target && !moved) return;
      // Exponential approach: covers ~95% of the remaining gap in EASE_TIME,
      // whatever the size of the step, so a two-step jump does not take twice
      // as long as a one-step one. Snapped at the end so `distance === target`
      // actually becomes true and this stops doing work.
      if (distance !== target) {
        distance += (target - distance) * (1 - Math.exp((-3 * dt) / EASE_TIME));
        if (Math.abs(target - distance) < 1e-4) distance = target;
      }
      apply();
    },

    reset(troops) {
      target = stepFor(troops, ZOOM_STEPS[0]![1]);
      distance = target;
      panX = 0;
      apply();
    },
  };
}
