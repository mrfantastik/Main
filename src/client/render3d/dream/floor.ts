import {
  Camera,
  Color,
  HalfFloatType,
  type DirectionalLight,
  Matrix4,
  Mesh,
  MeshPhongMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";

// The dreamscape floor: endless glossy hexagonal tiles that mirror what
// stands on them. The scene is rendered a second time from a camera mirrored
// in the floor plane; the tile shader blends that picture in, everywhere but
// the grout lines. It's a normal lit material underneath, so it still takes
// shadows, night and fog.

export class MirrorFloor {
  readonly mesh: Mesh;
  private readonly target: WebGLRenderTarget;
  private readonly textureMatrix = new Matrix4();
  private readonly vOrtho = new OrthographicCamera();
  private readonly vPersp = new PerspectiveCamera();
  private readonly rot = new Matrix4();
  private readonly camPos = new Vector3();
  private readonly look = new Vector3();
  private readonly view = new Vector3();
  private readonly normal = new Vector3(0, 1, 0);
  private readonly uniforms = {
    tMirror: { value: null as unknown },
    textureMatrix: { value: this.textureMatrix },
    reflectivity: { value: 0.32 },
    tileA: { value: new Color(0x5a534f) },
    tileB: { value: new Color(0x6a625d) },
    groutCol: { value: new Color(0x2e2a2a) },
  };

  constructor(size = 700) {
    this.target = new WebGLRenderTarget(512, 512, { type: HalfFloatType });
    this.uniforms.tMirror.value = this.target.texture;
    const geo = new PlaneGeometry(size, size);
    geo.rotateX(-Math.PI / 2);
    const mat = new MeshPhongMaterial({ color: 0xffffff, shininess: 70, specular: new Color(0x3a3440) });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("void main() {", "uniform mat4 textureMatrix;\nvarying vec4 vMirrorUv;\nvarying vec2 vFloorXZ;\nvoid main() {")
        .replace("#include <project_vertex>", "#include <project_vertex>\n  vMirrorUv = textureMatrix * vec4(position, 1.0);\n  vFloorXZ = (modelMatrix * vec4(position, 1.0)).xz;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "void main() {",
          `uniform sampler2D tMirror;
uniform float reflectivity;
uniform vec3 tileA;
uniform vec3 tileB;
uniform vec3 groutCol;
varying vec4 vMirrorUv;
varying vec2 vFloorXZ;
float floorHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// Hex tiles a little over half a unit across: returns the tile colour, grout
// in w. Far away (or seen from high up) a tile is only a few pixels wide, so
// the grout fades to its average and the tiles to one tone instead of
// shimmering.
vec4 hexTile(vec2 p) {
  p *= 1.6;
  const vec2 r = vec2(1.0, 1.7320508);
  vec2 a = mod(p, r) - r * 0.5;
  vec2 b = mod(p - r * 0.5, r) - r * 0.5;
  vec2 gv = dot(a, a) < dot(b, b) ? a : b;
  vec2 id = p - gv;
  vec2 q = abs(gv);
  float edge = max(dot(q, vec2(0.5, 0.8660254)), q.x);
  float px = max(length(dFdx(p)), length(dFdy(p)));
  float sharp = smoothstep(0.462 - px, 0.462 + px, edge);
  float far = smoothstep(0.08, 0.22, px);
  float grout = mix(sharp, 0.15, far);
  vec3 col = mix(tileA, tileB, mix(floorHash(id), 0.5, smoothstep(0.15, 0.4, px)));
  return vec4(mix(col, groutCol, grout), grout);
}
void main() {`,
        )
        .replace("#include <color_fragment>", "#include <color_fragment>\n  vec4 hexT = hexTile(vFloorXZ);\n  diffuseColor.rgb *= hexT.rgb * 1.6;")
        .replace("#include <opaque_fragment>", "  vec3 mirrored = texture2DProj(tMirror, vMirrorUv).rgb;\n  outgoingLight = mix(outgoingLight, mirrored, reflectivity * (1.0 - hexT.w));\n#include <opaque_fragment>");
    };
    this.mesh = new Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = -1;
  }

  /** Match the mirror picture to the drawing buffer (at half resolution: it's blurry in the tiles anyway). */
  setSize(w: number, h: number): void {
    this.target.setSize(Math.max(64, Math.round(w / 2)), Math.max(64, Math.round(h / 2)));
  }

  setNight(n: number): void {
    this.uniforms.reflectivity.value = 0.32 + n * 0.18;
  }

  /**
   * Render the mirrored scene for this frame's camera. The mirror pass reuses
   * the shadow maps the main pass draws, so it's skipped while a light that
   * casts shadows hasn't had its map drawn yet (the first frame, or dawn).
   */
  render(gl: WebGLRenderer, scene: Scene, camera: Camera, lights: readonly DirectionalLight[]): void {
    for (const l of lights) if (l.castShadow && !l.shadow.map) return;
    camera.updateMatrixWorld();
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    if (this.camPos.y <= 0.01) return;
    // Mirror the camera's position, view direction and up in the plane y = 0.
    this.view.copy(this.camPos).negate().reflect(this.normal).negate();
    this.rot.extractRotation(camera.matrixWorld);
    this.look.set(0, 0, -1).applyMatrix4(this.rot).add(this.camPos).negate().reflect(this.normal).negate();
    let v: OrthographicCamera | PerspectiveCamera;
    if ((camera as OrthographicCamera).isOrthographicCamera) {
      const c = camera as OrthographicCamera;
      v = this.vOrtho;
      Object.assign(v, { left: c.left, right: c.right, top: c.top, bottom: c.bottom, near: c.near, far: c.far, zoom: c.zoom });
    } else {
      const c = camera as PerspectiveCamera;
      v = this.vPersp;
      Object.assign(v, { fov: c.fov, aspect: c.aspect, near: c.near, far: c.far, zoom: c.zoom });
    }
    v.position.copy(this.view);
    v.up.set(0, 1, 0).applyMatrix4(this.rot).reflect(this.normal);
    v.lookAt(this.look);
    v.updateMatrixWorld();
    v.projectionMatrix.copy(camera.projectionMatrix);
    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(v.projectionMatrix).multiply(v.matrixWorldInverse).multiply(this.mesh.matrixWorld);

    this.mesh.visible = false;
    const shadows = gl.shadowMap.autoUpdate;
    gl.shadowMap.autoUpdate = false;
    const prev = gl.getRenderTarget();
    gl.setRenderTarget(this.target);
    gl.clear();
    gl.render(scene, v);
    gl.setRenderTarget(prev);
    gl.shadowMap.autoUpdate = shadows;
    this.mesh.visible = true;
  }

  dispose(): void {
    this.target.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshPhongMaterial).dispose();
  }
}
