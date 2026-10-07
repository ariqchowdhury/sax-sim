// Soft-tissue materials for the anatomical cutaway: MeshPhysical + a cheap subsurface approximation
// (wrapped diffuse from the key direction and a view-dependent scatter tint at grazing angles), so
// skin, lips, tongue and lungs read soft and fleshy instead of plastic. Cut-section faces use flat,
// mostly self-lit colours like an anatomical illustration.
import * as THREE from 'three';

export interface TissueOpts {
  color: THREE.ColorRepresentation;
  /** colour of light scattered under the surface (usually a saturated red) */
  scatter?: THREE.ColorRepresentation;
  /** 0…1 amount of the subsurface term */
  sss?: number;
  roughness?: number;
  /** moist tissue: clearcoat on top */
  wet?: number;
  sheen?: number;
  normalMap?: THREE.Texture;
  normalScale?: number;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
}

export function tissue(o: TissueOpts): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: o.color,
    roughness: o.roughness ?? 0.55,
    metalness: 0,
    clearcoat: o.wet ?? 0,
    clearcoatRoughness: 0.18,
    sheen: o.sheen ?? 0.35,
    sheenColor: new THREE.Color(o.scatter ?? 0xff8070).lerp(new THREE.Color(0xffffff), 0.4),
    sheenRoughness: 0.55,
    transparent: o.transparent ?? false,
    opacity: o.opacity ?? 1,
    depthWrite: !(o.transparent ?? false),
    side: o.side ?? THREE.FrontSide,
  });
  if (o.normalMap) {
    m.normalMap = o.normalMap;
    m.normalScale.setScalar(o.normalScale ?? 0.4);
  }
  const uniforms = {
    uScatter: { value: new THREE.Color(o.scatter ?? 0xd8584a) },
    uSss: { value: o.sss ?? 0.5 },
  };
  m.userData.tissue = uniforms;
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uScatter;\nuniform float uSss;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 nV = normalize(vNormal);
          vec3 vV = normalize(vViewPosition);
          float ndv = abs(dot(nV, vV));
          // grazing-angle scatter + a constant forward-scattered fill (light bleeding through thin tissue)
          float g = pow(1.0 - ndv, 2.0);
          totalEmissiveRadiance += uScatter * diffuseColor.rgb * uSss * (0.10 + 0.38 * g);
        }`,
      );
  };
  m.customProgramCacheKey = () => 'tissue';
  return m;
}

/** flat, mostly self-lit section colour (cut faces) */
export function cutMaterial(color: THREE.ColorRepresentation, lit = 0.45): THREE.MeshStandardMaterial {
  const c = new THREE.Color(color);
  return new THREE.MeshStandardMaterial({
    color: c, roughness: 1, metalness: 0, emissive: c.clone().multiplyScalar(lit), side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
}
