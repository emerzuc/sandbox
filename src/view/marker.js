import * as THREE from 'three';
import { WATER_Y } from '../world/river.js';

/**
 * Position marker under the plane. A gameplay shadow, not a physical one.
 *
 * Over water there is no ground-contact cue at all, and the chase camera turns
 * lateral position into a perspective estimate against banks that are rushing
 * past — the playtest said so in as many words. The physical shadow would not
 * help: the sun is low and side-on, so it lands well off to one side and reads
 * as *wrong* information. A soft disc directly beneath is what arcades have
 * used for forty years, for exactly this reason.
 */

const SIZE = 64;

function radialTexture() {
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (x + 0.5) / SIZE - 0.5;
      const dy = (y + 0.5) / SIZE - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      // Dense core, long soft skirt: the edge is where the eye reads position.
      const t = Math.max(0, 1 - r);
      const a = t * t * (3 - 2 * t);
      const i = (y * SIZE + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, SIZE, SIZE);
  tex.needsUpdate = true;
  return tex;
}

export class PositionMarker {
  constructor(scene) {
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 15),
      new THREE.MeshBasicMaterial({
        map: radialTexture(),
        color: 0x000000,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        // Sits a hair above the water and must never z-fight with it.
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      })
    );
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  /** @param pos the plane's interpolated render position */
  update(pos, visible) {
    this.mesh.visible = visible;
    this.mesh.position.set(pos.x, WATER_Y + 0.12, pos.z);
  }
}
