import * as THREE from 'three';
import { terrainHeight, WORLD_HALF_W } from './river.js';
import { createTerrainMaterial, decorateGeometry } from './terrainMaterial.js';

export const CHUNK_LEN = 120;

// The shoreline is the one silhouette the player reads at speed, and the bank
// rises over ~16 units of shore distance, so anything coarser than this
// serrates the water's edge into visible sawteeth.
const STEP_X = 2;
const STEP_Z = 2;

const AHEAD = 980;
const BEHIND = 160;

const COLS = Math.floor((WORLD_HALF_W * 2) / STEP_X) + 1;
const ROWS = Math.floor(CHUNK_LEN / STEP_Z) + 1;

function buildChunkGeometry(z0) {
  const count = COLS * ROWS;
  const pos = new Float32Array(count * 3);

  let p = 0;
  for (let r = 0; r < ROWS; r++) {
    const z = z0 + r * STEP_Z;
    for (let c = 0; c < COLS; c++) {
      const x = -WORLD_HALF_W + c * STEP_X;
      pos[p++] = x;
      pos[p++] = terrainHeight(x, z);
      pos[p++] = z;
    }
  }

  const idx = new Uint32Array((COLS - 1) * (ROWS - 1) * 6);
  let i = 0;
  for (let r = 0; r < ROWS - 1; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      const a = r * COLS + c;
      const b = a + 1;
      const d = a + COLS;
      const e = d + 1;
      idx[i++] = a; idx[i++] = d; idx[i++] = b;
      idx[i++] = b; idx[i++] = d; idx[i++] = e;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  decorateGeometry(geo);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Keeps a sliding window of terrain chunks around the player. Chunks are built
 * at most one per frame: a greybox that hitches teaches you nothing about feel,
 * and the whole point of phase 1 is to judge feel.
 */
export class Terrain {
  constructor(scene) {
    this.scene = scene;
    this.chunks = new Map();

    this.material = createTerrainMaterial();

  }

  /** @returns {number} chunks built this call */
  update(playerZ, budget = 1) {
    const first = Math.floor((playerZ - BEHIND) / CHUNK_LEN);
    const last = Math.floor((playerZ + AHEAD) / CHUNK_LEN);

    let built = 0;
    for (let ci = first; ci <= last && built < budget; ci++) {
      if (this.chunks.has(ci)) continue;
      const geo = buildChunkGeometry(ci * CHUNK_LEN);
      const mesh = new THREE.Mesh(geo, this.material);
      // Terrain self-shadowing is what makes the gorge read as deep, and
      // without castShadow there is nothing to cast.
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.scene.add(mesh);
      this.chunks.set(ci, mesh);
      built++;
    }

    for (const [ci, mesh] of this.chunks) {
      if (ci < first || ci > last) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        this.chunks.delete(ci);
      }
    }

    return built;
  }

  /** Fill the visible window immediately — used on boot and on respawn. */
  prime(playerZ) {
    while (this.update(playerZ, 64) > 0) { /* keep going until settled */ }
  }

  dispose() {
    for (const [, mesh] of this.chunks) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunks.clear();
  }
}
