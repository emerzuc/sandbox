import * as THREE from 'three';

/**
 * Three's `flatShading` derives the face normal in the fragment shader:
 *
 *     normal = normalize( cross( dFdx( vViewPosition ), dFdy( vViewPosition ) ) )
 *
 * On a sub-pixel sliver both derivatives can be zero, and normalize(0) is NaN.
 * One NaN texel is invisible on screen — until it lands in a half-float render
 * target, gets sampled by the water, and is smeared across the whole frame by
 * five mips of bloom. That is a black frame, and it is intermittent because it
 * needs a sliver to sit on a quad boundary just so. The reflection camera, low
 * and grazing, produces far more slivers than the main one, which is why it
 * showed up there first.
 *
 * Applied via onBeforeCompile so every flat-shaded material shares one fix.
 */
export function guardFlatNormals(shader) {
  const chunk = THREE.ShaderChunk.normal_fragment_begin;
  const unsafe = 'vec3 normal = normalize( cross( fdx, fdy ) );';
  if (!chunk.includes(unsafe)) {
    console.warn('guardFlatNormals: three changed normal_fragment_begin; guard not applied');
    return;
  }
  const safe = `vec3 normal = cross( fdx, fdy );
  {
    // Comparisons are false for NaN, so this also catches derivatives that were
    // already undefined, not just the zero-length case.
    float l2 = dot( normal, normal );
    normal = ( l2 > 1e-20 && l2 < 1e30 ) ? normal * inversesqrt( l2 ) : vec3( 0.0, 0.0, 1.0 );
  }`;
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <normal_fragment_begin>',
    chunk.replace(unsafe, safe)
  );
}
