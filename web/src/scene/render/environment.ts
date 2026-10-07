// Procedural photo-studio environment for image-based lighting (prefiltered with PMREM).
// Zero download: a dark cyclorama with a few large HDR softboxes (key, fill strip, overhead, rim
// strips) and a warm floor bounce — the kind of setup used for product shots of polished metal, so
// the lacquered brass picks up long, soft highlights instead of a uniform grey room.
import * as THREE from 'three';

export function buildStudioScene(): THREE.Scene {
  const scene = new THREE.Scene();
  // cyclorama: vertical gradient (dark ceiling, slightly lighter horizon, warm dark floor)
  const cyc = new THREE.Mesh(
    new THREE.SphereGeometry(10, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {},
      vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        void main(){
          float y = vDir.y;
          vec3 ceilC = vec3(0.020, 0.022, 0.028);
          vec3 horiz = vec3(0.090, 0.092, 0.100);
          vec3 floorC = vec3(0.060, 0.048, 0.036);
          vec3 c = y > 0.0 ? mix(horiz, ceilC, smoothstep(0.0, 0.7, y)) : mix(horiz, floorC, smoothstep(0.0, 0.25, -y));
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  scene.add(cyc);

  const box = (w: number, h: number, intensity: number, color: THREE.ColorRepresentation, pos: [number, number, number], soft = true): void => {
    const c = new THREE.Color(color).multiplyScalar(intensity);
    const mat = soft
      ? new THREE.ShaderMaterial({
          side: THREE.DoubleSide,
          uniforms: { uC: { value: c } },
          vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
          // softbox with a feathered edge and a slightly hotter centre
          fragmentShader: /* glsl */ `
            uniform vec3 uC; varying vec2 vUv;
            void main(){
              vec2 d = abs(vUv - 0.5) * 2.0;
              float e = (1.0 - smoothstep(0.75, 1.0, d.x)) * (1.0 - smoothstep(0.75, 1.0, d.y));
              float hot = 1.0 + 0.35 * (1.0 - dot(d, d) * 0.5);
              gl_FragColor = vec4(uC * e * hot, 1.0);
            }`,
        })
      : new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.set(pos[0], pos[1], pos[2]);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  // key: large softbox front-right, above (the default camera looks from +X)
  box(3.2, 2.4, 9, 0xfff3e2, [3.2, 2.6, 2.4]);
  // fill: tall strip front-left, dimmer and cooler
  box(1.0, 4.2, 3.2, 0xe6eeff, [2.8, 0.8, -3.2]);
  // overhead: wide panel straight above (long highlight along the body tube)
  box(4.5, 1.6, 4.5, 0xffffff, [0.2, 4.5, 0.3]);
  // rims: two narrow strips behind (edge definition on the silhouette)
  box(0.6, 4.6, 7, 0xdfe8ff, [-3.4, 1.2, 2.6]);
  box(0.6, 4.6, 5, 0xfff0dd, [-3.4, 1.2, -2.6]);
  // low warm bounce card (lights the underside of the bow and the inside of the bell)
  box(4.0, 1.2, 1.1, 0xffd9a8, [1.5, -2.6, 1.5]);
  return scene;
}
