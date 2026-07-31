import * as THREE from 'three';

/**
 * Greybox art. Boxes only, no textures, no detail modelling.
 *
 * The few colours here are *functional*, not art direction: the player must be
 * able to tell "kills me" from "refuels me" at 130 units of closing speed.
 * Everything with the same gameplay meaning shares a value.
 *
 * One template per kind is built at load and cloned per entity, so geometry and
 * materials are shared across every instance and nothing needs disposing when
 * an entity is culled.
 */

const mat = (color, opts = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.04, flatShading: true, ...opts });

export const MAT = {
  player: mat(0xe4e9ee),
  hostile: mat(0x8e979f),
  hostileDark: mat(0x676f76),
  fuel: mat(0x7e9a6b),
  bridge: mat(0x565d63),
  bullet: new THREE.MeshBasicMaterial({ color: 0xffe6a0 }),
};

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

export const BULLET_GEO = box(0.5, 0.5, 3.6);
export const DEBRIS_GEO = box(1.1, 1.1, 1.1);

export function makePlane() {
  const g = new THREE.Group();
  const fuselage = new THREE.Mesh(box(1.8, 1.5, 9), MAT.player);
  const nose = new THREE.Mesh(box(1.2, 1, 2.4), MAT.player);
  nose.position.z = 5.2;
  const wing = new THREE.Mesh(box(13, 0.55, 2.8), MAT.player);
  wing.position.z = -0.4;
  const tail = new THREE.Mesh(box(5.2, 0.45, 1.7), MAT.player);
  tail.position.z = -4.1;
  const fin = new THREE.Mesh(box(0.45, 2.3, 1.9), MAT.player);
  fin.position.set(0, 1.3, -4);
  g.add(fuselage, nose, wing, tail, fin);
  return g;
}

function buildTemplates() {
  const t = {};

  {
    const g = new THREE.Group();
    const hull = new THREE.Mesh(box(4.4, 2.2, 12), MAT.hostile);
    hull.position.y = 0.6;
    const deck = new THREE.Mesh(box(3, 2, 4), MAT.hostileDark);
    deck.position.set(0, 2.6, -1.4);
    g.add(hull, deck);
    t.ship = g;
  }

  {
    const g = new THREE.Group();
    const body = new THREE.Mesh(box(3, 2.6, 5.4), MAT.hostile);
    const boom = new THREE.Mesh(box(0.7, 0.7, 4.6), MAT.hostileDark);
    boom.position.z = -4.6;
    const rotor = new THREE.Mesh(box(12, 0.22, 0.8), MAT.hostileDark);
    rotor.position.y = 1.9;
    rotor.name = 'rotor';
    g.add(body, boom, rotor);
    t.heli = g;
  }

  {
    const g = new THREE.Group();
    const body = new THREE.Mesh(box(1.5, 1.3, 8), MAT.hostile);
    const wing = new THREE.Mesh(box(8, 0.45, 2.2), MAT.hostileDark);
    wing.position.z = -0.8;
    g.add(body, wing);
    t.jet = g;
  }

  {
    const g = new THREE.Group();
    const tank = new THREE.Mesh(box(5, 7, 5), MAT.fuel);
    tank.position.y = 3.6;
    const base = new THREE.Mesh(box(7, 0.9, 7), MAT.hostileDark);
    g.add(tank, base);
    t.fuel = g;
  }

  {
    // Built at unit width; the instance sets scale.x to span the channel.
    const g = new THREE.Group();
    const deck = new THREE.Mesh(box(1, 2.6, 9), MAT.bridge);
    deck.position.y = 7;
    const railA = new THREE.Mesh(box(1, 2.8, 0.9), MAT.hostileDark);
    railA.position.set(0, 9.5, 4.1);
    const railB = railA.clone();
    railB.position.z = -4.1;
    g.add(deck, railA, railB);
    t.bridge = g;
  }

  return t;
}

const TEMPLATES = buildTemplates();

export function makeEntityMesh(kind) {
  return TEMPLATES[kind].clone();
}
