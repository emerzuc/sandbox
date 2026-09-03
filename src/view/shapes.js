import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PALETTE, SCALE } from '../art/direction.js';
import { guardFlatNormals } from './shaderGuards.js';

/**
 * Entity models — "1982 box art made real".
 *
 * There is no modelling tool and no asset pipeline here, so everything is built
 * from lofted cross-sections and extruded planforms in code. That constraint is
 * less limiting than it sounds: at 200 units and 80 units/s of closing speed the
 * only things the player can actually resolve are silhouette, proportion and
 * colour. Surface detail costs triangles and buys nothing. So every model is
 * authored as an outline first — the shape a kid would have airbrushed on a
 * cartridge box — and detailed only where the outline needs breaking up.
 *
 * Two rules drive the structure of this file:
 *
 *   - Silhouette over surface. `loft()` and `slab()` cover every shape here,
 *     because a hull, a wing, a fin and a truss member are all "a 2D outline
 *     given thickness". Nothing needs a third modelling primitive.
 *   - One template per kind, built once and cloned per entity, so geometry and
 *     materials are shared. Hundreds of entities stream through a run; anything
 *     per-instance would leak. `assemble()` also merges every part that shares a
 *     material, so a whole aircraft is two or three draw calls, not twelve.
 *
 * Colour never appears literally in this file — it comes from the art direction
 * or it does not exist. The one liberty is `shade()`, which darkens a palette
 * colour in value only: it separates a facet from its neighbour without letting
 * a new hue into the game.
 */

// --------------------------------------------------------------- materials

/** Value-only shift of a palette colour. Hue never leaves the palette. */
const shade = (hex, k) => new THREE.Color(hex).multiplyScalar(k);

const std = (color, opts = {}) => {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.1, flatShading: true, ...opts });
  m.onBeforeCompile = guardFlatNormals;
  return m;
};

export const MAT = {
  // Player: near-white body, saturated red accents. Distinguishing the player
  // from a hostile at a glance is a gameplay requirement, so the two families
  // share no value and no hue — hostiles never get white and never get bright.
  player: std(PALETTE.planeBody, { roughness: 0.45, metalness: 0.22 }),
  playerAccent: std(PALETTE.planeAccent, { roughness: 0.5 }),
  playerGlass: std(shade(PALETTE.planeBody, 0.18), { roughness: 0.12, metalness: 0.6 }),

  hostile: std(PALETTE.hostileBody),
  hostileDark: std(shade(PALETTE.hostileBody, 0.5)),
  hostileAccent: std(PALETTE.hostileAccent),

  fuel: std(PALETTE.fuelBody, { roughness: 0.55 }),
  bridge: std(PALETTE.bridgeBody),

  bullet: new THREE.MeshBasicMaterial({ color: PALETTE.tracer }),
};

// -------------------------------------------------------------- primitives

/** One cross-section of a loft: outline scaled by (sx, sy), lifted by oy, at z. */
const sec = (z, sx = 1, sy = sx, oy = 0) => ({ z, sx, sy, oy });

/**
 * Sweep a closed 2D outline along +Z through a run of scaled cross-sections.
 * This is the workhorse: fuselages, hulls, booms, nose cones and pods are all
 * the same operation with different numbers. A section scaled to zero collapses
 * to a point and is left uncapped, which is how every nose in here is made.
 */
function loft(outline, sections) {
  // Winding decides which way the faces point, and half these outlines get
  // mirrored to build a left-hand part. Normalising here means callers can
  // write the outline in whatever order reads best.
  let pts = outline;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const q = pts[(i + 1) % pts.length];
    area += pts[i][0] * q[1] - q[0] * pts[i][1];
  }
  if (area < 0) pts = pts.slice().reverse();

  const n = pts.length;
  const v = [];
  const at = (i, k) => {
    const s = sections[k];
    return [pts[i][0] * s.sx, pts[i][1] * s.sy + s.oy, s.z];
  };
  const push = (...ps) => { for (const p of ps) v.push(p[0], p[1], p[2]); };

  for (let k = 0; k < sections.length - 1; k++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      push(at(i, k), at(j, k), at(j, k + 1));
      push(at(i, k), at(j, k + 1), at(i, k + 1));
    }
  }

  const cap = (k, front) => {
    const s = sections[k];
    if (Math.abs(s.sx * s.sy) < 1e-3) return;
    const m = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const p = at(i, k);
      m[0] += p[0] / n; m[1] += p[1] / n; m[2] += p[2] / n;
    }
    for (let i = 0; i < n; i++) {
      const a = at(i, k);
      const b = at((i + 1) % n, k);
      if (front) push(m, a, b); else push(m, b, a);
    }
  };
  cap(sections.length - 1, true);
  cap(0, false);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * A planform — points in the XZ plane — given thickness in Y. Wings, tails,
 * fins and truss members are all planforms; the outline is the whole read and
 * the thickness is noise, so it stays constant and cheap.
 */
const slab = (points, thickness) =>
  loft(points.map(([x, z]) => [x, -z]), [sec(-thickness / 2), sec(thickness / 2)])
    .rotateX(-Math.PI / 2);

/** Same planform trick, stood on edge: for vertical fins, points are [height, z]. */
const upright = (points, thickness) => slab(points, thickness).rotateZ(Math.PI / 2);

/** Mirror a planform across X, for the opposite wing. */
const mirrorX = (points) => points.map(([x, z]) => [-x, z]);

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const tube = (rTop, rBot, h, seg = 8) => new THREE.CylinderGeometry(rTop, rBot, h, seg);

/** Unit outlines. Everything round in this game is an octagon or a hexagon. */
const OCT = [
  [1, 0], [0.7, 0.7], [0, 1], [-0.7, 0.7],
  [-1, 0], [-0.7, -0.7], [0, -1], [0.7, -0.7],
];
const HEX = [
  [1, 0], [0.5, 0.87], [-0.5, 0.87], [-1, 0], [-0.5, -0.87], [0.5, -0.87],
];

// ---------------------------------------------------------------- assembly

/**
 * Merge every part sharing a material into a single mesh. Attributes are
 * normalised first: `mergeGeometries` refuses a mixed set, and UVs are dead
 * weight when no material in the game samples a texture.
 */
function mergeAll(geos) {
  const prepared = geos.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    for (const key of Object.keys(ng.attributes)) {
      if (key !== 'position' && key !== 'normal') ng.deleteAttribute(key);
    }
    return ng;
  });
  return prepared.length === 1 ? prepared[0] : mergeGeometries(prepared);
}

/** parts: [material, geometry][] -> Group with one merged mesh per material. */
function assemble(parts) {
  const byMat = new Map();
  for (const [mat, geo] of parts) {
    if (!byMat.has(mat)) byMat.set(mat, []);
    byMat.get(mat).push(geo);
  }
  const g = new THREE.Group();
  for (const [mat, geos] of byMat) g.add(new THREE.Mesh(mergeAll(geos), mat));
  return g;
}

// ------------------------------------------------------------- projectiles

// A dart, not a cube: the tracer is drawn unlit, so its taper is the only cue
// that tells the player which end is travelling.
export const BULLET_GEO = tube(0.09, 0.26, 3.2, 6).rotateX(Math.PI / 2);

/**
 * Wreckage. An icosahedron pushed off-sphere so no two facets catch the light
 * the same way. The jitter is a hash of the vertex position rather than of its
 * index, so the duplicated corners of adjacent faces move together and the
 * solid stays closed — and, being a hash, it is the same on every run.
 */
export const DEBRIS_GEO = (() => {
  const g = new THREE.IcosahedronGeometry(0.72, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
    const k = 0.72 + (h - Math.floor(h)) * 0.55;
    p.setXYZ(i, x * k, y * k, z * k);
  }
  g.computeVertexNormals();
  return g;
})();

// ------------------------------------------------------------------- plane

/**
 * The player: a cranked-delta interceptor, nose on +Z.
 *
 * Seen from the chase camera — 27 back, 12.5 up — the read is almost entirely
 * planform and spine, so that is where the accent goes: red nose, red dorsal
 * stripe running back into a red fin, red wingtip pods. Against bright water
 * the red holds; against dark cliff the near-white body holds. Whichever way
 * the background swings, one of the two is still separating the plane from it.
 */
function buildPlane() {
  const half = SCALE.planeWingspan / 2;

  const FUSE = [
    [1, -0.05], [0.72, 0.62], [0, 0.86], [-0.72, 0.62],
    [-1, -0.05], [-0.66, -0.72], [0, -0.9], [0.66, -0.72],
  ];

  const body = loft(FUSE, [
    sec(-5.2, 0.62, 0.6, 0.08),
    sec(-3.4, 0.85, 0.82, 0.02),
    sec(-1.0, 1.02, 0.98, 0),
    sec(1.4, 0.98, 0.92, -0.02),
    sec(3.4, 0.74, 0.62, -0.12),
  ]);

  const nose = loft(FUSE, [
    sec(3.4, 0.74, 0.62, -0.12),
    sec(5.2, 0.4, 0.32, -0.2),
    sec(6.4, 0.04, 0.03, -0.24),
  ]);

  const canopy = loft(HEX, [
    sec(0.2, 0.5, 0.34, 0.72),
    sec(1.7, 0.56, 0.42, 0.74),
    sec(3.1, 0.26, 0.2, 0.66),
  ]);

  const wingHalf = [
    [0.85, 2.7], [2.7, 1.8], [half, -1.1],
    [half, -2.2], [2.7, -2.9], [0.85, -2.6],
  ];
  const wingR = slab(wingHalf, 0.42).translate(0, -0.12, 0);
  const wingL = slab(mirrorX(wingHalf), 0.42).translate(0, -0.12, 0);

  const podHalf = [
    sec(-2.6, 0.11, 0.11), sec(-2.0, 0.34, 0.34),
    sec(1.5, 0.34, 0.34), sec(2.2, 0.12, 0.12),
  ];
  const podR = loft(HEX, podHalf).translate(half - 0.35, -0.1, -1.2);
  const podL = loft(HEX, podHalf).translate(-half + 0.35, -0.1, -1.2);

  const stabHalf = [[0.5, -3.0], [2.9, -4.1], [2.9, -4.9], [0.5, -4.9]];
  const stabR = slab(stabHalf, 0.3).translate(0, 0.1, 0);
  const stabL = slab(mirrorX(stabHalf), 0.3).translate(0, 0.1, 0);

  const fin = upright([[0, -2.4], [0, -5.1], [2.9, -5.1], [2.3, -3.4]], 0.26)
    .translate(0, 0.5, 0);

  // Dorsal stripe: stops short of the canopy so the two never intersect.
  const spine = slab([[0.26, 0.1], [0.26, -4.9], [-0.26, -4.9], [-0.26, 0.1]], 0.34)
    .translate(0, 0.78, 0);

  const nozzle = tube(0.55, 0.42, 0.9, 8).rotateX(Math.PI / 2).translate(0, 0.02, -5.5);

  return assemble([
    [MAT.player, body], [MAT.player, wingR], [MAT.player, wingL],
    [MAT.player, stabR], [MAT.player, stabL],
    [MAT.playerAccent, nose], [MAT.playerAccent, podR], [MAT.playerAccent, podL],
    [MAT.playerAccent, fin], [MAT.playerAccent, spine],
    [MAT.playerGlass, canopy], [MAT.playerGlass, nozzle],
  ]);
}

// ---------------------------------------------------------------- hostiles

/** Gunboat. Broadside-on to the player (the sim yaws it ±90°), so the read is
 *  the side view: sheer line, blockhouse, funnel, mast. Bow on +Z. */
function buildShip() {
  const HULL = [
    [-1, 1.1], [-1, 0.15], [-0.42, -1.0],
    [0.42, -1.0], [1, 0.15], [1, 1.1],
  ];

  const hull = loft(HULL, [
    sec(-6.2, 2.5, 1.9, 0.15),
    sec(-3.0, 2.8, 2.1, 0.05),
    sec(1.0, 2.8, 2.1, 0),
    sec(4.2, 2.3, 2.0, 0.15),
    sec(6.2, 1.0, 1.8, 0.45),
    sec(7.2, 0.1, 1.6, 0.7),
  ]);

  // Hard-edged blockhouse, chamfered toward the bow. Lofts run along +Z, so
  // standing one up is a rotation rather than a second primitive; the outline's
  // second axis becomes depth, hence the chamfer being authored on -y.
  const PLAN = [[1, -0.72], [0.62, -1], [-0.62, -1], [-1, -0.72], [-1, 1], [1, 1]];
  const house = loft(PLAN, [sec(0, 1.6, 2.1), sec(2.5, 1.5, 2.0)])
    .rotateX(-Math.PI / 2).translate(0, 1.15, -1.4);
  const bridgeDeck = loft(PLAN, [sec(0, 1.05, 1.15), sec(1.2, 0.95, 1.05)])
    .rotateX(-Math.PI / 2).translate(0, 3.6, -1.9);

  const turret = loft(HEX, [sec(0, 0.9), sec(1.2, 0.85), sec(1.6, 0.5)])
    .rotateX(-Math.PI / 2).translate(0, 1.2, 3.6);
  const barrel = tube(0.16, 0.16, 2.4, 6).rotateX(Math.PI / 2).translate(0, 2.05, 5.0);

  const funnel = tube(0.62, 0.78, 2.0, 8).translate(0, 5.2, -2.7);
  // Nothing on a hostile reaches past its collision radius: the ship kills
  // inside 6 units, so it must not have a mast the player can fly through.
  const mast = box(0.26, 2.6, 0.26).translate(0, 5.0, -0.2);
  const radar = slab([[1.2, 0.16], [1.2, -0.16], [-1.2, -0.16], [-1.2, 0.16]], 0.22)
    .translate(0, 6.2, -0.2);

  const strakeR = slab([[2.95, 5.6], [2.95, -6.0], [2.55, -6.0], [2.55, 5.6]], 0.5)
    .translate(0, 1.0, 0);
  const strakeL = slab([[-2.95, 5.6], [-2.95, -6.0], [-2.55, -6.0], [-2.55, 5.6]], 0.5)
    .translate(0, 1.0, 0);

  return assemble([
    [MAT.hostile, hull], [MAT.hostile, house], [MAT.hostile, bridgeDeck],
    [MAT.hostileDark, turret], [MAT.hostileDark, barrel],
    [MAT.hostileDark, mast], [MAT.hostileDark, radar],
    [MAT.hostileAccent, funnel], [MAT.hostileAccent, strakeR], [MAT.hostileAccent, strakeL],
  ]);
}

/** Gunship. Modelled nose on -Z: it drifts back down the river toward the
 *  player, so the face the player sees is the cockpit, not the tail. */
function buildHeli() {
  const cabin = loft(OCT, [
    sec(-3.6, 0.35, 0.4, -0.15),
    sec(-2.6, 1.1, 1.0, -0.1),
    sec(-1.0, 1.5, 1.35, 0),
    sec(1.0, 1.45, 1.3, 0.05),
    sec(2.2, 1.0, 0.95, 0.15),
  ]);

  const boom = loft(HEX, [
    sec(1.8, 0.55, 0.5, 0.25),
    sec(4.0, 0.4, 0.36, 0.3),
    sec(6.1, 0.3, 0.28, 0.42),
  ]);

  const tailFin = upright([[0, 5.7], [0, 6.5], [2.0, 6.5], [1.6, 5.5]], 0.22)
    .translate(0, 0.3, 0);
  const tailPlane = slab([[1.1, 5.4], [1.1, 6.3], [-1.1, 6.3], [-1.1, 5.4]], 0.2)
    .translate(0, 0.45, 0);
  const tailRotor = tube(0.85, 0.85, 0.14, 8).rotateZ(Math.PI / 2).translate(0.5, 1.35, 5.9);

  const stubHalf = [[2.3, 0.6], [2.3, -0.9], [0.9, -0.9], [0.9, 0.6]];
  const stubR = slab(stubHalf, 0.3).translate(0, 0.2, 0);
  const stubL = slab(mirrorX(stubHalf), 0.3).translate(0, 0.2, 0);
  const podR = tube(0.34, 0.34, 2.6, 6).rotateX(Math.PI / 2).translate(2.05, -0.1, -0.2);
  const podL = tube(0.34, 0.34, 2.6, 6).rotateX(Math.PI / 2).translate(-2.05, -0.1, -0.2);

  const skidR = slab([[1.5, 2.0], [1.5, -2.2], [1.2, -2.2], [1.2, 2.0]], 0.28)
    .translate(0, -2.1, 0);
  const skidL = slab([[-1.5, 2.0], [-1.5, -2.2], [-1.2, -2.2], [-1.2, 2.0]], 0.28)
    .translate(0, -2.1, 0);
  const struts = [
    box(0.18, 1.3, 0.2).translate(1.35, -1.5, 1.4),
    box(0.18, 1.3, 0.2).translate(-1.35, -1.5, 1.4),
    box(0.18, 1.3, 0.2).translate(1.35, -1.5, -1.4),
    box(0.18, 1.3, 0.2).translate(-1.35, -1.5, -1.4),
  ];

  const mast = tube(0.22, 0.3, 0.8, 6).translate(0, 1.7, -0.2);

  const g = assemble([
    [MAT.hostile, cabin], [MAT.hostile, stubR], [MAT.hostile, stubL],
    [MAT.hostileDark, boom], [MAT.hostileDark, tailFin], [MAT.hostileDark, tailPlane],
    [MAT.hostileDark, tailRotor], [MAT.hostileDark, mast],
    [MAT.hostileDark, skidR], [MAT.hostileDark, skidL], ...struts.map((s) => [MAT.hostileDark, s]),
    [MAT.hostileAccent, podR], [MAT.hostileAccent, podL],
  ]);

  // Authored with the nose near the origin because that is how the numbers read;
  // recentred here so the mass sits on the collision sphere instead of trailing
  // a tail boom the player can fly through.
  for (const c of g.children) c.geometry.translate(0, 0, -1.2);

  // Separate mesh because it spins: entities.js drives it by name every frame.
  const blade = [[5.0, 0.3], [5.0, -0.3], [0.4, -0.38], [0.4, 0.38]];
  const rotor = new THREE.Mesh(
    mergeAll([
      tube(0.42, 0.5, 0.34, 8),
      slab(blade, 0.09),
      slab(blade, 0.09).rotateY(Math.PI / 2),
      slab(mirrorX(blade), 0.09),
      slab(mirrorX(blade), 0.09).rotateY(Math.PI / 2),
    ]),
    MAT.hostileDark
  );
  rotor.name = 'rotor';
  rotor.position.set(0, 2.05, -1.4);
  g.add(rotor);

  return g;
}

/** Interceptor. Nose on -Z, because it flies at the player. Twin canted fins
 *  and a straight arrow planform so it never reads as the player's aircraft. */
function buildJet() {
  const body = loft(OCT, [
    sec(4.8, 0.5, 0.5, 0.1),
    sec(2.6, 0.95, 0.85, 0.05),
    sec(0, 1.05, 0.9, 0),
    sec(-2.4, 0.85, 0.7, -0.05),
    sec(-4.4, 0.42, 0.34, -0.1),
  ]);
  const nose = loft(OCT, [
    sec(-4.4, 0.42, 0.34, -0.1),
    sec(-5.6, 0.05, 0.04, -0.12),
  ]);

  const wingHalf = [[0.8, -2.0], [4.5, 1.4], [4.5, 2.4], [0.8, 3.0]];
  const wingR = slab(wingHalf, 0.34).translate(0, -0.1, 0);
  const wingL = slab(mirrorX(wingHalf), 0.34).translate(0, -0.1, 0);

  const finShape = [[0, 2.6], [0, 4.6], [1.9, 4.4], [1.5, 3.0]];
  const finR = upright(finShape, 0.22).rotateZ(-0.22).translate(1.15, 0.35, 0);
  const finL = upright(finShape, 0.22).rotateZ(0.22).translate(-1.15, 0.35, 0);

  const canopy = loft(HEX, [
    sec(-2.8, 0.34, 0.22, 0.5),
    sec(-1.5, 0.5, 0.36, 0.58),
    sec(-0.2, 0.32, 0.24, 0.5),
  ]);
  const intakeR = box(0.55, 0.7, 2.4).translate(1.05, -0.25, 1.2);
  const intakeL = box(0.55, 0.7, 2.4).translate(-1.05, -0.25, 1.2);
  const nozzleR = tube(0.4, 0.5, 0.9, 6).rotateX(Math.PI / 2).translate(0.55, 0.05, 4.9);
  const nozzleL = tube(0.4, 0.5, 0.9, 6).rotateX(Math.PI / 2).translate(-0.55, 0.05, 4.9);

  return assemble([
    [MAT.hostile, body], [MAT.hostile, wingR], [MAT.hostile, wingL],
    [MAT.hostileDark, canopy], [MAT.hostileDark, intakeR], [MAT.hostileDark, intakeL],
    [MAT.hostileDark, nozzleR], [MAT.hostileDark, nozzleL],
    [MAT.hostileAccent, nose], [MAT.hostileAccent, finR], [MAT.hostileAccent, finL],
  ]);
}

/** Fuel depot: a lathed tank on a platform standing in the river. Green is
 *  reserved for this one object in the whole game — nothing the player must
 *  avoid is ever allowed to wear it. */
function buildFuel() {
  const tank = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0, 0.6), new THREE.Vector2(3.0, 0.6),
      new THREE.Vector2(3.4, 1.3), new THREE.Vector2(3.4, 7.2),
      new THREE.Vector2(3.05, 8.0), new THREE.Vector2(1.7, 8.6),
      new THREE.Vector2(0, 8.8),
    ],
    12
  );

  const deck = tube(6.4, 6.8, 1.0, 12).translate(0, 0.1, 0);
  const band = new THREE.CylinderGeometry(3.55, 3.55, 1.0, 12, 1, true).translate(0, 4.4, 0);

  // Pilings: the depot stands in the water, and the legs are what says so.
  const pilings = [[4.3, 4.3], [-4.3, 4.3], [4.3, -4.3], [-4.3, -4.3]].map(([x, z]) =>
    box(0.9, 4.2, 0.9).translate(x, -2.0, z)
  );

  const gantry = slab([[1.6, 0.9], [6.1, 0.7], [6.1, -0.7], [1.6, -0.9]], 0.7)
    .translate(0, 7.4, 0);
  const hose = tube(0.34, 0.34, 2.6, 6).translate(5.6, 5.9, 0);
  const vent = tube(0.34, 0.34, 1.8, 6).translate(-1.2, 9.3, 0);

  return assemble([
    [MAT.fuel, tank],
    [MAT.bridge, deck], [MAT.bridge, band], [MAT.bridge, gantry],
    [MAT.bridge, hose], [MAT.bridge, vent],
    ...pilings.map((p) => [MAT.bridge, p]),
  ]);
}

/**
 * Bridge. Built at unit width on X; the instance sets scale.x to the channel
 * span, which runs roughly 95–130 units.
 *
 * That scaling is the whole design constraint. A tower or a post modelled with
 * real thickness on X would be stretched a hundredfold, so the bridge is built
 * from two things that survive the stretch: a constant Y/Z cross-section (deck,
 * girders, chords), and a truss whose members are sheared parallelograms — a
 * member's Y thickness is authored in Y, so it stays honest at any span while
 * the bay simply gets longer. Only the four end towers carry an X dimension,
 * and theirs is authored small enough that the stretch lands them at about a
 * unit and a half wide whatever the river is doing.
 */
function buildBridge() {
  const parts = [];

  const deck = box(1, 0.5, 9.2).translate(0, 7.85, 0);
  parts.push([MAT.bridge, deck]);

  // The girder faces and the top chords are the only parts of a bridge the
  // player ever sees head-on, and bridgeBody against a cliff is one dark shape
  // on another. The accent line is what makes the gate read as a gate.
  for (const z of [4.6, -4.6]) {
    parts.push([MAT.bridge, box(1, 2.3, 0.85).translate(0, 6.75, z)]);
    parts.push([MAT.hostileAccent, box(1, 0.42, 0.6).translate(0, 10.7, z)]);
    parts.push([MAT.hostileAccent, box(1, 0.5, 0.14).translate(0, 7.3, z + Math.sign(z) * 0.47)]);
  }

  // Warren truss: alternating diagonals, no verticals. Twelve bays lands each
  // bay at roughly 8 units across a typical channel — steep enough to read as
  // a truss from the cockpit rather than as a fence.
  const BAYS = 12;
  const yLo = 8.05;
  const yHi = 10.5;
  const t = 0.22;
  for (const z of [4.6, -4.6]) {
    for (let b = 0; b < BAYS; b++) {
      const x0 = -0.5 + b / BAYS;
      const x1 = x0 + 1 / BAYS;
      const up = b % 2 === 0;
      const y0 = up ? yLo : yHi;
      const y1 = up ? yHi : yLo;
      const member = loft(
        [[x0, y0 - t], [x1, y1 - t], [x1, y1 + t], [x0, y0 + t]],
        [sec(z - 0.25), sec(z + 0.25)]
      );
      parts.push([MAT.bridge, member]);
    }
  }

  // Abutment towers, one pair per bank, with a portal beam tying them.
  for (const x of [0.493, -0.493]) {
    for (const z of [4.6, -4.6]) {
      parts.push([MAT.bridge, box(0.014, 6.6, 1.0).translate(x, 9.0, z)]);
      parts.push([MAT.hostileAccent, box(0.018, 0.8, 1.15).translate(x, 11.2, z)]);
    }
    parts.push([MAT.bridge, box(0.02, 0.6, 10.4).translate(x, 12.1, 0)]);
  }

  return assemble(parts);
}

// ------------------------------------------------------------------ export

const PLANE = buildPlane();

const TEMPLATES = {
  ship: buildShip(),
  heli: buildHeli(),
  jet: buildJet(),
  fuel: buildFuel(),
  bridge: buildBridge(),
};

export function makePlane() {
  return PLANE.clone();
}

export function makeEntityMesh(kind) {
  return TEMPLATES[kind].clone();
}
