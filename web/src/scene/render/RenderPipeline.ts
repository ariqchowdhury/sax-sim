// Render pipeline: renderer settings, studio IBL + key/fill/rim lights, key-light shadows (updated
// only when something moved), a baked soft contact shadow under the instrument, and a linear-HDR
// post chain (MSAA → GTAO → bloom → tone mapping/sRGB) whose cost is set by the quality tier.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { HorizontalBlurShader } from 'three/examples/jsm/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/examples/jsm/shaders/VerticalBlurShader.js';
import { buildStudioScene } from './environment';
import { autoState, registerQualityTarget, TIERS, type RenderQuality } from './quality';
import { backdrop } from './textures';

/** objects flagged with userData.noAO (or transparent / handles / points / lines) are left out of the AO G-buffer */
class FilteredGTAOPass extends GTAOPass {
  private hidden: THREE.Object3D[] = [];
  private half = true;
  constructor(scene: THREE.Scene, camera: THREE.Camera, w: number, h: number) {
    super(scene, camera, w, h);
    const self = this as unknown as { _overrideVisibility: () => void; _restoreVisibility: () => void };
    self._overrideVisibility = () => {
      scene.traverseVisible((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        const mat = Array.isArray(m) ? m[0] : m;
        if (
          (o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as unknown as { isLine2?: boolean }).isLine2 ||
          o.userData.noAO || o.userData.isHandle || (mat && (mat.transparent || !mat.depthWrite || !mat.depthTest || mat.visible === false))
        ) this.hidden.push(o);
      });
      for (const o of this.hidden) o.visible = false;
    };
    self._restoreVisibility = () => {
      for (const o of this.hidden) o.visible = true;
      this.hidden.length = 0;
    };
  }
  override setSize(w: number, h: number): void {
    super.setSize(this.half ? Math.max(1, Math.round(w / 2)) : w, this.half ? Math.max(1, Math.round(h / 2)) : h);
  }
}

/** Soft contact shadow: depth-from-below of the instrument, blurred, baked into a floor decal. */
class ContactShadow {
  readonly mesh: THREE.Mesh;
  private rt: THREE.WebGLRenderTarget;
  private rtBlur: THREE.WebGLRenderTarget;
  private cam: THREE.OrthographicCamera;
  private depthMat: THREE.MeshDepthMaterial;
  private hq = new FullScreenQuad(new THREE.ShaderMaterial(HorizontalBlurShader));
  private vq = new FullScreenQuad(new THREE.ShaderMaterial(VerticalBlurShader));
  private mat: THREE.ShaderMaterial;
  static readonly LAYER = 7;

  constructor(private size = 0.7, private height = 0.32, res = 512) {
    this.rt = new THREE.WebGLRenderTarget(res, res);
    this.rtBlur = new THREE.WebGLRenderTarget(res, res);
    this.rt.texture.generateMipmaps = this.rtBlur.texture.generateMipmaps = false;
    this.cam = new THREE.OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0, height);
    this.cam.rotation.x = Math.PI / 2; // looking up (+Y)
    this.cam.layers.set(ContactShadow.LAYER);
    this.depthMat = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
    this.depthMat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        // darker the closer to the floor (fragCoordZ 0 = floor)
        'float a = pow(1.0 - fragCoordZ, 2.2); gl_FragColor = vec4(vec3(0.0), a);',
      );
    };
    this.depthMat.depthTest = false;
    this.depthMat.depthWrite = false;
    // depth test off + max blending: the nearest-to-floor surface wins regardless of draw order
    this.depthMat.blending = THREE.CustomBlending;
    this.depthMat.blendEquation = THREE.MaxEquation;
    this.depthMat.blendEquationAlpha = THREE.MaxEquation;
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { tShadow: { value: this.rt.texture }, uOpacity: { value: 0.85 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tShadow; uniform float uOpacity; varying vec2 vUv;
        void main(){
          float a = texture2D(tShadow, vec2(vUv.x, 1.0 - vUv.y)).a;
          float r = length(vUv - 0.5) * 2.0;
          a *= 1.0 - smoothstep(0.7, 1.0, r);
          gl_FragColor = vec4(0.0, 0.0, 0.0, a * uOpacity);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), this.mat);
    this.mesh.renderOrder = -2;
    this.mesh.userData.noAO = true;
    this.mesh.name = 'contactShadow';
    this.mesh.raycast = () => {};
  }

  bake(renderer: THREE.WebGLRenderer, scene: THREE.Scene, roots: THREE.Object3D[]): void {
    const box = new THREE.Box3();
    for (const r of roots) box.expandByObject(r);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const floorY = box.min.y - 0.0008;
    this.mesh.position.set(c.x, floorY, c.z);
    this.cam.position.set(c.x, floorY, c.z);
    this.cam.updateMatrixWorld();
    const tagged: THREE.Object3D[] = [];
    for (const r of roots)
      r.traverseVisible((o) => {
        if ((o as THREE.Mesh).isMesh && !o.userData.isHandle) { o.layers.enable(ContactShadow.LAYER); tagged.push(o); }
      });
    const bg = scene.background, ov = scene.overrideMaterial;
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    scene.background = null;
    scene.overrideMaterial = this.depthMat;
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, this.cam);
    scene.overrideMaterial = ov;
    scene.background = bg;
    for (const o of tagged) o.layers.disable(ContactShadow.LAYER);
    // blur: two separable passes of decreasing radius
    const res = this.rt.width;
    for (const k of [2.2, 1.0]) {
      (this.hq.material as THREE.ShaderMaterial).uniforms.tDiffuse.value = this.rt.texture;
      (this.hq.material as THREE.ShaderMaterial).uniforms.h.value = k / res;
      renderer.setRenderTarget(this.rtBlur);
      this.hq.render(renderer);
      (this.vq.material as THREE.ShaderMaterial).uniforms.tDiffuse.value = this.rtBlur.texture;
      (this.vq.material as THREE.ShaderMaterial).uniforms.v.value = k / res;
      renderer.setRenderTarget(this.rt);
      this.vq.render(renderer);
    }
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    void this.size; void this.height;
  }
}

export class RenderPipeline {
  readonly key: THREE.DirectionalLight;
  readonly fill: THREE.DirectionalLight;
  readonly rim: THREE.DirectionalLight;
  readonly contact: ContactShadow;
  readonly backdrop: THREE.Mesh;
  quality: RenderQuality;
  fps = 60;
  private composer: EffectComposer | null = null;
  private ao: FilteredGTAOPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private w = 1;
  private h = 1;
  private lastT = 0;
  private shadowDirty = 2;
  private contactRoots: THREE.Object3D[] = [];
  private contactDirty = false;

  constructor(readonly renderer: THREE.WebGLRenderer, readonly scene: THREE.Scene, readonly camera: THREE.PerspectiveCamera) {
    const r = renderer;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = false;

    // image-based lighting from the procedural studio
    const pmrem = new THREE.PMREMGenerator(r);
    const studio = buildStudioScene();
    scene.environment = pmrem.fromScene(studio, 0.02).texture;
    scene.environmentIntensity = 1.0;
    studio.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
    pmrem.dispose();
    // backdrop: a full-screen quad drawn first (not scene.background) so every tier tone-maps it identically
    const bgMat = new THREE.MeshBasicMaterial({ map: backdrop(0x1c2330, 0x2a3240, 0x0a0c11), depthTest: false, depthWrite: false });
    bgMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', 'vec4 mvPosition = vec4(transformed, 1.0);\ngl_Position = vec4(transformed.xy, 1.0, 1.0);');
    };
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat);
    bg.frustumCulled = false;
    bg.renderOrder = -1000;
    bg.userData.noAO = true;
    bg.name = 'backdrop';
    bg.raycast = () => {};
    scene.add(bg);
    this.backdrop = bg;

    // direct lights: key (shadows), cool fill, rim from behind
    this.key = new THREE.DirectionalLight(0xfff2e0, 2.2);
    this.key.position.set(1.4, 1.9, 0.9);
    this.fill = new THREE.DirectionalLight(0xdfe8ff, 0.45);
    this.fill.position.set(1.2, 0.4, -1.4);
    this.rim = new THREE.DirectionalLight(0xe8eeff, 1.4);
    this.rim.position.set(-1.4, 1.2, 0.6);
    for (const l of [this.key, this.fill, this.rim]) scene.add(l, l.target);
    const sh = this.key.shadow;
    sh.bias = -0.0002;
    sh.normalBias = 0.0006;
    sh.radius = 3;
    sh.camera.near = 0.1;
    sh.camera.far = 4;

    this.contact = new ContactShadow();
    scene.add(this.contact.mesh);
    this.quality = registerQualityTarget(this);
    this.applyQuality(this.quality);
  }

  /** aim lights + shadow frustum at the given object bounds and bake the contact shadow from `roots` */
  frame(focus: THREE.Object3D[], contactRoots: THREE.Object3D[]): void {
    const box = new THREE.Box3();
    for (const o of focus) box.expandByObject(o);
    const c = box.getCenter(new THREE.Vector3());
    const rad = box.getBoundingSphere(new THREE.Sphere()).radius;
    for (const l of [this.key, this.fill, this.rim]) {
      const dir = l.position.clone().sub(l.target.position).normalize();
      l.target.position.copy(c);
      l.position.copy(c).addScaledVector(dir, 2);
    }
    const cam = this.key.shadow.camera;
    cam.left = cam.bottom = -rad * 1.02;
    cam.right = cam.top = rad * 1.02;
    cam.near = 2 - rad * 1.1;
    cam.far = 2 + rad * 1.1;
    cam.updateProjectionMatrix();
    this.contactRoots = contactRoots;
    this.contactDirty = true;
    this.shadowDirty = 2;
  }

  /** something that casts shadows moved: refresh the shadow map on the next frame */
  invalidateShadows(): void {
    this.shadowDirty = Math.max(this.shadowDirty, 1);
  }

  applyQuality(level: RenderQuality): void {
    this.quality = level;
    const t = TIERS[level];
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, t.maxDpr));
    // shadows
    this.key.castShadow = t.shadow > 0;
    if (t.shadow > 0 && this.key.shadow.mapSize.x !== t.shadow) {
      this.key.shadow.mapSize.set(t.shadow, t.shadow);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
    this.contact.mesh.visible = t.contact;
    // post chain
    this.composer?.dispose();
    this.ao?.dispose();
    this.bloom?.dispose();
    this.composer = null;
    this.ao = null;
    this.bloom = null;
    if (t.msaa > 0) {
      const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: t.msaa });
      const comp = new EffectComposer(r, rt);
      comp.addPass(new RenderPass(this.scene, this.camera));
      if (t.ao) {
        const ao = new FilteredGTAOPass(this.scene, this.camera, 2, 2);
        ao.updateGtaoMaterial({ radius: 0.014, distanceExponent: 1.4, thickness: 0.008, scale: 1.0, samples: 8, distanceFallOff: 1 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 8 });
        ao.blendIntensity = 0.7;
        comp.addPass(ao);
        this.ao = ao;
      }
      if (t.bloom) {
        const b = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.06, 0.2, 4.0);
        comp.addPass(b);
        this.bloom = b;
      }
      comp.addPass(new OutputPass());
      this.composer = comp;
    }
    this.shadowDirty = 2;
    this.setSize(this.w, this.h);
    autoState.reset();
  }

  setSize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.renderer.setSize(w, h, false);
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
  }

  render(): void {
    const now = performance.now();
    if (this.lastT > 0) {
      const dt = now - this.lastT;
      this.fps += (1000 / Math.max(1, dt) - this.fps) * 0.05;
      autoState.push(dt);
    }
    this.lastT = now;
    const r = this.renderer;
    if (this.contactDirty && this.contactRoots.length) {
      this.contactDirty = false;
      this.contact.mesh.visible = false;
      this.contact.bake(r, this.scene, this.contactRoots);
      this.contact.mesh.visible = TIERS[this.quality].contact;
    }
    if (this.shadowDirty > 0 && this.key.castShadow) {
      r.shadowMap.needsUpdate = true;
      this.shadowDirty--;
    }
    if (this.composer) this.composer.render();
    else r.render(this.scene, this.camera);
  }
}
