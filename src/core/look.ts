/**
 * THE HOUSE MATERIAL — one place that decides what everything in this game is
 * made of.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * Every figure, barrel, prize and boss was `MeshLambertMaterial`, which is a
 * purely diffuse shading model: it has no highlight at all. Put our crowd beside
 * the reference's and that single fact is most of the difference. Theirs reads as
 * moulded plastic toys — a hard bright spot on every helmet, a sheen down the
 * side of every barrel — and ours reads as coloured paper. It was never the
 * geometry; a Lambert sphere and a Phong sphere have the same silhouette, and
 * only one of them looks smooth.
 *
 * Blinn-Phong is the cheapest shading model that has a specular term. On this
 * scene it is a handful of extra instructions per fragment on a fill rate that
 * is nowhere near the budget, and it buys the whole "toy" read at once.
 *
 * ---------------------------------------------------------------------------
 * Why these two numbers
 * ---------------------------------------------------------------------------
 * `SPECULAR` is dark on purpose. It is a MULTIPLIER on the highlight, and the
 * scene's key light is 2.1 white, so anything near mid-grey blows the highlight
 * out to a white blob that eats the colour underneath — on a blue helmet at
 * forty pixels, that is the difference between "shiny" and "missing".
 *
 * `SHININESS` sets how tight the spot is. Low numbers spread it into a broad
 * sheen that just looks like the object is lighter; high numbers shrink it to a
 * few pixels that flicker as the crowd bobs. 40 puts the spot at roughly a
 * quarter of a helmet, which is what the reference frames show.
 *
 * ---------------------------------------------------------------------------
 * What does NOT get this
 * ---------------------------------------------------------------------------
 * The road, the water and the bridge structure stay Lambert. They are the ground
 * the toys sit on, and a glossy road competes with the things standing on it —
 * the highlight is a cue that says "this is an object", so spending it on the
 * backdrop spends it on nothing.
 */

import * as THREE from "three";

/** Highlight colour. See the note above before raising it. */
export const TOY_SPECULAR = 0x686f78;
/** Highlight tightness. */
export const TOY_SHININESS = 52;

type ToyParams = Omit<THREE.MeshPhongMaterialParameters, "specular" | "shininess">;

/**
 * A character/prop material: diffuse exactly as Lambert gave it, plus a
 * controlled highlight. Drop-in for `new THREE.MeshLambertMaterial(params)`.
 */
export function toyMaterial(params: ToyParams = {}): THREE.MeshPhongMaterial {
  return new THREE.MeshPhongMaterial({
    ...params,
    specular: new THREE.Color(TOY_SPECULAR),
    shininess: TOY_SHININESS,
  });
}
