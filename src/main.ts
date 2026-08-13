/**
 * COMMANDER OVERKILL — entry point.
 *
 * Milestone 1.2a: the corridor exists, it scrolls, and your thumb steers the
 * Commander across it at a locked 60Hz simulation rate. Everything downstream
 * (swarm, gates, ordnance) hangs off this loop.
 */

import { GameLoop } from "./core/loop";
import { StateMachine } from "./core/state";
import { createStage } from "./core/renderer";
import { bus } from "./core/events";
import { TouchDriver } from "./input/touch";
import { createCorridor } from "./mechanics/lane";
import { Commander } from "./entities/commander";
import { mountPerfOverlay } from "./ui/perf";
import type { CanvasTexture, Mesh, MeshLambertMaterial } from "three";

/** Metres per second the world slides toward the player. Placeholder pace for feel. */
const SCROLL_SPEED = 9;

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const ui = document.getElementById("ui") as HTMLElement;

const stage = createStage(canvas);
const state = new StateMachine();
const touch = new TouchDriver(canvas);

const corridor = createCorridor();
stage.scene.add(corridor);

const commander = new Commander();
stage.scene.add(commander.object);

// The road texture's V offset is the entire illusion of forward motion for now.
// Once the swarm and gates move for real, this stays as the ground plane's
// contribution and nothing else has to know about it.
const road = corridor.children[0] as Mesh;
const roadTex = (road.material as MeshLambertMaterial).map as CanvasTexture;

let scrolled = 0;

const loop = new GameLoop({
  update(dt) {
    if (state.state !== "running") return;
    commander.update(dt, touch.lane);
    scrolled += SCROLL_SPEED * dt;
  },
  render(alpha) {
    commander.render(alpha);
    // repeat.y is tiles-per-corridor, so dividing by it converts metres to tiles.
    roadTex.offset.y = (scrolled / (70 / roadTex.repeat.y)) % 1;
    stage.renderer.render(stage.scene, stage.camera);
  },
  onStats(stats) {
    bus.emit("frame:stats", stats);
  },
});

mountPerfOverlay(ui, stage.renderer);

state.transition("briefing");
state.transition("running");
loop.start();

// Pause when the tab is hidden: a backgrounded run should not drain a phone
// battery, and it also means the loop never has a huge delta to swallow.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) loop.stop();
  else loop.start();
});
