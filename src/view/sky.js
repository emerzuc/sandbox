import * as THREE from 'three';
import { PALETTE, biomeAt } from '../art/direction.js';

/**
 * Sky dome. The palette has carried skyZenith / skyMid / skyHorizon since the
 * art direction was written, and the biomes blend them — but until now nothing
 * drew them: the background was the fog colour, flat. The 1982 box art is
 * *built* on its sky gradient, and the water is a near-mirror that reflects
 * whatever is up there, so a real sky lifts both halves of the frame at once.
 *
 * One inverted sphere that rides with the camera. It writes no depth, so the
 * post chain still treats it as background (no motion blur on the sky), and
 * it sits on layer 0, so the water's mirrored camera sees it too.
 */

const RADIUS = 1600;

export class Sky {
  constructor(scene) {
    const sun = new THREE.Vector3(...PALETTE.sunDirection).normalize();

    this.uniforms = {
      uZenith: { value: new THREE.Color() },
      uMid: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uFog: { value: new THREE.Color() },
      uSunColor: { value: new THREE.Color() },
      uSunDir: { value: sun },
    };

    const material = new THREE.ShaderMaterial({
      name: 'Sky',
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          // The dome is centred on the camera, so the direction is the
          // vertex itself; the projection ignores the camera's translation.
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith;
        uniform vec3 uMid;
        uniform vec3 uHorizon;
        uniform vec3 uFog;
        uniform vec3 uSunColor;
        uniform vec3 uSunDir;
        varying vec3 vDir;

        void main() {
          vec3 d = normalize(vDir);
          float y = d.y;

          // Three stops, biased toward the horizon: most of the sky the chase
          // camera sees is the band just above the ridge line.
          vec3 sky = mix(uHorizon, uMid, smoothstep(0.0, 0.22, y));
          sky = mix(sky, uZenith, smoothstep(0.18, 0.75, y));

          // The last few degrees above the horizon meet the fogged terrain,
          // so they must agree with the fog colour or the ridge line shows a
          // seam. Below the horizon (seen only in the reflection) it darkens.
          sky = mix(uFog, sky, smoothstep(0.0, 0.09, y));
          sky *= 1.0 - 0.35 * smoothstep(0.0, -0.3, y);

          // Sun: a tight disc and a wide warm halo, both in the palette's sun
          // colour. The halo is what gives the box art its raking glow.
          float s = max(dot(d, uSunDir), 0.0);
          vec3 sun = uSunColor * (pow(s, 900.0) * 3.0 + pow(s, 14.0) * 0.45 + pow(s, 3.0) * 0.08);

          gl_FragColor = vec4(sky + sun, 1.0);
          #include <colorspace_fragment>
        }
      `,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(RADIUS, 32, 18), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    scene.add(this.mesh);
  }

  update(camera, playerZ) {
    this.mesh.position.copy(camera.position);
    const b = biomeAt(playerZ);
    this.uniforms.uZenith.value.copy(b.skyZenith);
    this.uniforms.uMid.value.copy(b.skyMid);
    this.uniforms.uHorizon.value.copy(b.skyHorizon);
    this.uniforms.uFog.value.copy(b.fogColor);
    this.uniforms.uSunColor.value.copy(b.sunColor);
  }
}
