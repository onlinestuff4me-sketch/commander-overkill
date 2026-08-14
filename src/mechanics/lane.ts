/**
 * LANE MANAGER — the corridor's geometry, and the one place that owns the
 * mapping from "normalised steering input" to "world X".
 *
 * Everything that needs to know how wide the road is asks here. When the
 * corridor widens for a boss arena, it widens in one file.
 */

import * as THREE from "three";

/**
 * Half the carriageway, in metres.
 *
 * WAS 3.4, AND THAT WAS MOST OF THE STRATEGY PROBLEM. A 6.8 m road is narrower
 * than a grown crowd, so every placement spanned it, every placement was
 * therefore unavoidable, and the only question a gate ever asked was "which
 * third of this wall do you want" — never "do you want this at all".
 *
 * 5.6 is set by the screen rather than by taste. Measured against the current
 * camera (52° vertical, 22° above the horizon, portrait), the visible half-width
 * on the road plane runs:
 *
 *     z      -6     -12     -20     -30     -45
 *     half  3.87    5.12    6.79    8.87   12.00   metres
 *
 * Content is READ at roughly z −20 to −30 and COMMITTED to by about z −12, so a
 * 5.6 m half-width is comfortably inside the frame everywhere a decision is
 * actually being made, and only overflows in the last two seconds — where the
 * reference clip's road overflows too. The screen was already carrying twice the
 * lateral room the road was using.
 *
 * It costs nothing at the far end and buys two things at the near end: content
 * that can leave a gap wide enough to drive through, and a crowd that only fills
 * the road at ~250 troops instead of ~120, so most of a run is played by an army
 * small enough to dodge with. That second one is emergent rather than authored,
 * and it is the good kind: being enormous now costs you manoeuvring room.
 */
export const CORRIDOR_HALF_WIDTH = 5.6;
/** How far down -Z the road is drawn. Beyond this the fog has taken over anyway. */
export const CORRIDOR_LENGTH = 70;

/* -------------------------------------------------------------------------- */
/* The bridge                                                                  */
/* -------------------------------------------------------------------------- */

/** How far the deck stands above the water. Only the silhouette matters — the
 *  camera never looks over the edge — so this is set by what makes the deck read
 *  as a structure, not by anything structural. */
const DECK_HEIGHT = 7;
const DECK_THICKNESS = 0.55;
const WATER_COLOR = 0x1d5a78;

const RAIL_COLOR = 0xd9dde4;
const RAIL_HEIGHT = 0.85;
const RAIL_POST_GAP = 2.4;

/** Tower red, straight off the reference's bridge. It is the only saturated
 *  colour in the environment, which is what makes the towers land as landmarks
 *  rather than as more scenery. */
const TOWER_COLOR = 0xc0392b;
const CABLE_COLOR = 0x8f97a6;
const TOWER_HEIGHT = 13;
const TOWER_WIDTH = 0.85;
/** Metres outboard of the kerb. Clear of the road, close enough to frame it. */
const TOWER_INSET = 1.3;
/** Spacing and the first tower's distance. 38 m is ~6 s at the default scroll —
 *  often enough to mark progress, rare enough that a tower arriving is an event. */
const TOWER_GAP = 40;
/** Where the first tower starts, measured back from the corridor's near end.
 *  Only sets the opening phase now that towers scroll and recycle. */
const TOWER_NEAR = 30;
const TOWER_COUNT = Math.ceil(CORRIDOR_LENGTH / TOWER_GAP) + 2;
/** Once a tower is this far behind the camera it wraps to the back of the set.
 *  The camera sits at z ≈ 9.5, so this is comfortably out of frame. */
const TOWER_RECYCLE_Z = 26;

/** Gap between the vertical hangers dropping from the main cable. Close enough
 *  to read as a run of them at speed, far enough apart not to become a wall. */
const HANGER_GAP = 7.5;
/** Fraction of the drop from cable to rail that a hanger actually spans. Less
 *  than 1 so the bars stop above head height: at full length, one every few
 *  metres turned both kerbs into a picket fence and shut the view down. */
const HANGER_SPAN = 0.55;

/** Where a tower's shadow falls, in metres. Down-screen-right, because the key
 *  light sits up-screen-left — see the note in core/renderer.ts. Every fake
 *  shadow in the project uses the same sign convention. */
const SHADOW_OFF_X = 0.9;
const SHADOW_OFF_Z = 1.4;

/** Normalised lane [-1, 1] → world X. */
export function laneToX(lane: number): number {
  return lane * CORRIDOR_HALF_WIDTH;
}

/**
 * THE BRIDGE.
 *
 * The corridor used to be a grey strip on flat green grass under a flat blue
 * sky, and side by side with the reference that one fact did more damage than
 * everything else combined: there was nothing in frame except the road and the
 * content on it, so there was no depth, no scale, and nothing to read speed
 * against except the dashes.
 *
 * Everything here is a box or a plane and all of it is static, so the whole
 * environment costs a handful of draw calls and never allocates. It is also the
 * cheapest place in the project to buy atmosphere: a suspension bridge really
 * IS made of boxes, so primitives are not a compromise here the way they are on
 * a character.
 *
 * THE SHADOWS ARE FAKE AND THAT IS THE POINT. No shadow maps (see the note in
 * core/renderer.ts — they are the second thing that kills a mobile frame). A
 * tower's shadow is a dark translucent quad lying on the deck at the offset the
 * scene's key light would throw it. It is one triangle pair, it is exactly
 * right for a light that never moves, and it is the single strongest depth cue
 * in the reference footage.
 */
export interface CorridorSystem {
  readonly object: THREE.Group;
  /** Scroll the towers toward the camera and recycle them. Call once per tick. */
  update(dt: number, scrollSpeed: number): void;
}

export function createCorridor(): CorridorSystem {
  const group = new THREE.Group();

  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(CORRIDOR_HALF_WIDTH * 2, CORRIDOR_LENGTH),
    new THREE.MeshLambertMaterial({ map: roadTexture() }),
  );
  road.rotation.x = -Math.PI / 2;
  road.position.z = -CORRIDOR_LENGTH / 2 + 8;
  group.add(road);

  // WATER, not grass. Wide enough to fill the frame at every aspect ratio and
  // long enough to reach the fog. Dark, because the deck and the crowd are both
  // pale and the contrast is what makes the road pop out of the frame.
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(320, 420),
    new THREE.MeshLambertMaterial({ color: WATER_COLOR }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, -DECK_HEIGHT, road.position.z - 120);
  group.add(water);

  // Kerbs: the player needs an unambiguous read on where the wall is, because
  // steering into it is how you miss a gate.
  const kerbMat = new THREE.MeshLambertMaterial({ color: 0xf5f0e1 });
  for (const side of [-1, 1]) {
    const kerb = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.4, CORRIDOR_LENGTH), kerbMat);
    kerb.position.set(side * CORRIDOR_HALF_WIDTH, 0.18, road.position.z);
    group.add(kerb);
  }

  // The deck's own thickness, so the road is a structure standing over water
  // rather than a decal floating on it.
  const deckMat = new THREE.MeshLambertMaterial({ color: 0x6f7480 });
  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(CORRIDOR_HALF_WIDTH * 2 + 0.9, DECK_THICKNESS, CORRIDOR_LENGTH),
    deckMat,
  );
  deck.position.set(0, -DECK_THICKNESS / 2 - 0.01, road.position.z);
  group.add(deck);

  addRailings(group, road.position.z);
  const towers = addTowers(group, road.position.z);

  return {
    object: group,
    update(dt, scrollSpeed) {
      // TOWERS MOVE. They used to be nailed to fixed Z, which is defensible —
      // the world is what scrolls, not the bridge — and completely wrong to look
      // at: you never passed one, so the only large object in the scene never
      // changed, and its shadow lay across the deck like paint. Playtest read
      // exactly that: "the shadows do not move realistically".
      //
      // Scrolling them costs one group translation each and buys the single best
      // moment in the environment — driving under a tower while its shadow
      // sweeps back over the crowd.
      const step = scrollSpeed * dt;
      for (const t of towers) {
        t.position.z += step;
        if (t.position.z > TOWER_RECYCLE_Z) t.position.z -= TOWER_GAP * towers.length;
      }
    },
  };
}

/**
 * Railings down both sides — a top rail on regular posts.
 *
 * Two instanced meshes for the whole corridor. They matter more than they look
 * like they should: they are the only vertical detail at the road's edge, so
 * they are what the eye uses to judge how fast the world is moving past.
 */
function addRailings(group: THREE.Group, roadZ: number): void {
  const mat = new THREE.MeshLambertMaterial({ color: RAIL_COLOR });
  const posts = Math.floor(CORRIDOR_LENGTH / RAIL_POST_GAP);

  for (const side of [-1, 1]) {
    const x = side * (CORRIDOR_HALF_WIDTH + 0.45);
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.12, CORRIDOR_LENGTH),
      mat,
    );
    rail.position.set(x, RAIL_HEIGHT, roadZ);
    group.add(rail);

    const post = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.1, RAIL_HEIGHT, 0.1),
      mat,
      posts,
    );
    post.frustumCulled = false;
    const m = new THREE.Matrix4();
    for (let i = 0; i < posts; i++) {
      m.makeTranslation(x, RAIL_HEIGHT / 2, roadZ + CORRIDOR_LENGTH / 2 - i * RAIL_POST_GAP);
      post.setMatrixAt(i, m);
    }
    group.add(post);
  }
}

/**
 * Suspension towers, their cables, and the shadows they throw across the deck.
 *
 * Placed at fixed Z rather than scrolling: the corridor's content moves toward
 * the camera but the WORLD does not, and a tower that slid past would have to
 * be recycled like a barrel. Standing still, they read as the bridge you are
 * driving along — and because the road texture scrolls underneath them, nothing
 * about that reads as wrong.
 */
function addTowers(group: THREE.Group, roadZ: number): THREE.Group[] {
  const towers: THREE.Group[] = [];
  const towerMat = new THREE.MeshLambertMaterial({ color: TOWER_COLOR });
  const cableMat = new THREE.MeshLambertMaterial({ color: CABLE_COLOR });
  // Fake shadows: unlit, translucent, no fog. Fog would tint them toward the
  // sky at distance and a shadow that gets LIGHTER as it recedes reads as a
  // rendering fault rather than as shade.
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x1b2a3a,
    transparent: true,
    opacity: 0.26,
    depthWrite: false,
    fog: false,
  });

  for (let i = 0; i < TOWER_COUNT; i++) {
    // Each tower is its own group so the whole assembly — legs, beams and the
    // shadow it throws — scrolls as one thing and cannot come apart.
    const tower = new THREE.Group();
    tower.position.z = roadZ + CORRIDOR_LENGTH / 2 - TOWER_NEAR - i * TOWER_GAP;
    group.add(tower);
    towers.push(tower);
    const z = 0;

    for (const side of [-1, 1]) {
      const x = side * (CORRIDOR_HALF_WIDTH + TOWER_INSET);
      const leg = new THREE.Mesh(
        new THREE.BoxGeometry(TOWER_WIDTH, TOWER_HEIGHT, TOWER_WIDTH),
        towerMat,
      );
      leg.position.set(x, TOWER_HEIGHT / 2 - DECK_THICKNESS, z);
      tower.add(leg);
    }

    // Two crossbeams. The upper one is what turns two uprights into a gateway
    // you drive through, which is the whole silhouette.
    for (const y of [TOWER_HEIGHT * 0.62, TOWER_HEIGHT * 0.93]) {
      const beam = new THREE.Mesh(
        new THREE.BoxGeometry((CORRIDOR_HALF_WIDTH + TOWER_INSET) * 2, TOWER_WIDTH * 0.8, TOWER_WIDTH),
        towerMat,
      );
      beam.position.set(0, y, z);
      tower.add(beam);
    }

    // The tower's shadow, lying across the deck. Offset down-screen-right to
    // match the key light in core/renderer.ts — if that light ever moves, this
    // offset moves with it or the world stops agreeing with itself.
    const shade = new THREE.Mesh(
      new THREE.PlaneGeometry(CORRIDOR_HALF_WIDTH * 2 + 1.2, TOWER_WIDTH * 2.6),
      shadowMat,
    );
    shade.rotation.x = -Math.PI / 2;
    shade.position.set(SHADOW_OFF_X, 0.014, z + SHADOW_OFF_Z);
    tower.add(shade);
  }

  // Main cables: one long box per side, sagging is not modelled — at this
  // camera the sag is under a pixel and a straight run reads as taut steel.
  for (const side of [-1, 1]) {
    const cable = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.14, CORRIDOR_LENGTH),
      cableMat,
    );
    cable.position.set(
      side * (CORRIDOR_HALF_WIDTH + TOWER_INSET),
      TOWER_HEIGHT * 0.93,
      roadZ,
    );
    group.add(cable);

    // Vertical hangers dropping from the cable to the deck edge.
    const hangers = Math.floor(CORRIDOR_LENGTH / HANGER_GAP);
    const drop = (TOWER_HEIGHT * 0.93 - RAIL_HEIGHT) * HANGER_SPAN;
    const hanger = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.07, drop, 0.07),
      cableMat,
      hangers,
    );
    hanger.frustumCulled = false;
    const m = new THREE.Matrix4();
    for (let i = 0; i < hangers; i++) {
      m.makeTranslation(
        side * (CORRIDOR_HALF_WIDTH + TOWER_INSET),
        TOWER_HEIGHT * 0.93 - drop / 2,
        roadZ + CORRIDOR_LENGTH / 2 - i * HANGER_GAP,
      );
      hanger.setMatrixAt(i, m);
    }
    group.add(hanger);
  }

  return towers;
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
