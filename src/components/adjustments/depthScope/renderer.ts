export interface DepthPreview {
  width: number;
  height: number;
  pixels: Uint8Array;
  normals: Uint8Array | null;
  meanNearness: number;
}

export interface Camera {
  yaw: number;
  pitch: number;
  zoom: number;
  offset: [number, number, number];
}

export interface Frame {
  orientation: number;
  flipH: boolean;
  flipV: boolean;
}

export interface PointUniforms {
  mode: number;
  reveal: number;
  lens?: { min: number; max: number; minFade: number; maxFade: number; amount: number };
  fog?: { amount: number; start: number; density: number; height: number; color: [number, number, number] };
  relight?: { ambientGain: number; softness: number; lights: Float32Array; count: number };
  motion?: { amount: number; parallax: number; reference: number; radial: boolean; axis: [number, number] };
  contour?: { depths: [number, number]; strength: number; color: [number, number, number] };
}

export interface Overlay {
  lines: number[];
  triangles: number[];
  points: number[];
}

export const MODE_LENS = 0;
export const MODE_FOG = 1;
export const MODE_RELIGHT = 2;
export const MODE_MOTION = 3;
export const MODE_MASK = 4;
export const MAX_LIGHTS = 8;
export const DEPTH_SCALE = 0.85;
const FOV = (32 * Math.PI) / 180;

const POINT_VS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_color;
uniform sampler2D u_normal;
uniform ivec2 u_size;
uniform mat4 u_mvp;
uniform vec2 u_extent;
uniform vec2 u_effectAspect;
uniform ivec3 u_frame;
uniform float u_pointScale;
uniform float u_reveal;
uniform int u_mode;
uniform vec4 u_lens;
uniform float u_lensAmount;
uniform vec4 u_fog;
uniform vec3 u_fogColor;
uniform vec3 u_relight;
uniform vec4 u_lights[${MAX_LIGHTS * 4}];
uniform vec4 u_motion;
uniform vec2 u_motionAxis;
uniform int u_ghost;
uniform vec4 u_contour;
uniform vec3 u_accent;
out vec4 v_color;

vec2 toDisplay(vec2 uv) {
  vec2 p = uv;
  if (u_frame.x == 1) p = vec2(1.0 - uv.y, uv.x);
  else if (u_frame.x == 2) p = vec2(1.0 - uv.x, 1.0 - uv.y);
  else if (u_frame.x == 3) p = vec2(uv.y, 1.0 - uv.x);
  if (u_frame.y != 0) p.x = 1.0 - p.x;
  if (u_frame.z != 0) p.y = 1.0 - p.y;
  return p;
}

float softPow(float x) { return x * (0.8 + 0.2 * x); }

void main() {
  ivec2 cell = ivec2(gl_VertexID % u_size.x, gl_VertexID / u_size.x);
  vec4 texel = texelFetch(u_color, cell, 0);
  vec2 uv = (vec2(cell) + 0.5) / vec2(u_size);
  vec2 p = toDisplay(uv);
  float n = texel.a;
  float dist = 1.0 - n;
  vec3 color = texel.rgb;
  float alpha = 1.0;
  float size = 1.0;

  if (u_mode == ${MODE_LENS}) {
    float far = 1.0 - smoothstep(u_lens.x - max(u_lens.z, 1e-4), u_lens.x, n);
    float near = smoothstep(u_lens.y, u_lens.y + max(u_lens.w, 1e-4), n);
    float b = clamp(softPow(far) + softPow(near), 0.0, 1.0) * u_lensAmount;
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(color, vec3(luma), 0.6 * b) * (1.0 - 0.4 * b);
    alpha = 1.0 - 0.72 * b;
    size = 1.0 + 2.4 * b;
  } else if (u_mode == ${MODE_FOG}) {
    float zNear = 1.0 / 1.1;
    float distance = (1.0 / (n + 0.1) - zNear) / (10.0 - zNear);
    float t = clamp((distance - u_fog.y) / max(1.0 - u_fog.y, 1e-4), 0.0, 1.0);
    float optical = u_fog.z * t * exp(-u_fog.w * (1.0 - p.y));
    float norm = 1.0 - exp(-u_fog.z);
    float fog = clamp(u_fog.x * (1.0 - exp(-optical)) / max(norm, 1e-4), 0.0, 1.0);
    color = mix(color, u_fogColor, fog);
    size = 1.0 + 0.6 * fog;
  } else if (u_mode == ${MODE_MASK}) {
    float lower = smoothstep(u_lens.x - max(u_lens.z, 1e-4), u_lens.x, n);
    float upper = 1.0 - smoothstep(u_lens.y, u_lens.y + max(u_lens.w, 1e-4), n);
    float band = lower * upper;
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luma) * 0.3, color, band);
    alpha = mix(0.4, 1.0, band);
  } else if (u_mode == ${MODE_RELIGHT}) {
    vec3 raw = texelFetch(u_normal, cell, 0).rgb * (255.0 / 127.5);
    vec3 nrm = normalize(vec3(raw.x - 1.0, 1.0 - raw.y, 1.0 - raw.z) + vec3(0.0, 0.0, 1e-5));
    vec3 pe = vec3((uv - 0.5) * u_effectAspect, dist);
    vec3 gain = vec3(u_relight.x);
    float softness = u_relight.y;
    for (int i = 0; i < ${MAX_LIGHTS}; i++) {
      if (i >= int(u_relight.z)) break;
      vec4 d0 = u_lights[i * 4];
      vec4 d1 = u_lights[i * 4 + 1];
      vec4 d2 = u_lights[i * 4 + 2];
      vec4 d3 = u_lights[i * 4 + 3];
      vec3 l;
      float atten = 1.0;
      if (d0.x == 2.0) {
        l = d2.xyz;
      } else {
        vec3 d = d0.yzw - pe;
        float dist2 = max(dot(d, d), 1e-8);
        l = d * inversesqrt(dist2);
        atten = d1.w / (d1.w + dist2);
        if (d0.x == 1.0) atten *= smoothstep(d2.w, d3.x, -dot(l, d2.xyz));
      }
      float diffuse = max((dot(nrm, l) + softness) / (1.0 + softness), 0.0);
      gain += d1.xyz * diffuse * atten;
    }
    vec3 lin = pow(color, vec3(2.2)) * max(gain, vec3(0.0));
    color = pow(lin / (1.0 + 0.25 * lin), vec3(1.0 / 2.2));
  }

  if (u_contour.z > 0.0) {
    vec2 gap = abs(vec2(dist) - u_contour.xy);
    float glow = (1.0 - smoothstep(0.004, 0.02, min(gap.x, gap.y))) * u_contour.z;
    color = mix(color, u_accent, 0.85 * glow);
    alpha = max(alpha, glow);
    size *= 1.0 + 0.5 * glow;
  }

  vec3 world = vec3((p.x - 0.5) * u_extent.x, (0.5 - p.y) * u_extent.y, -dist * ${DEPTH_SCALE} * u_reveal);

  int ghost = gl_InstanceID + u_ghost;
  if (u_mode == ${MODE_MOTION} && ghost > 0) {
    float k = clamp(mix(1.0, n / u_motion.z, u_motion.y), 0.0, 4.0);
    float s = (ghost <= 2 ? -1.0 : 1.0) * (ghost == 1 || ghost == 4 ? 1.0 : 0.5);
    vec2 axis = u_motion.w > 0.5 ? world.xy * 2.0 : u_motionAxis;
    world.xy += axis * k * u_motion.x * 0.07 * s;
    alpha = 0.26 * (1.0 - 0.45 * abs(s));
  }

  gl_Position = u_mvp * vec4(world, 1.0);
  gl_PointSize = clamp(u_pointScale * size / gl_Position.w, 1.0, 40.0);
  v_color = vec4(clamp(color, 0.0, 1.0), alpha);
}`;

const POINT_FS = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 o_color;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float a = v_color.a * (1.0 - smoothstep(0.5, 1.0, r2));
  if (a < 0.01) discard;
  o_color = vec4(v_color.rgb * a, a);
}`;

const OVERLAY_VS = `#version 300 es
precision highp float;
uniform mat4 u_mvp;
uniform float u_dpr;
in vec3 a_pos;
in vec4 a_color;
in vec2 a_shape;
out vec4 v_color;
out float v_kind;
void main() {
  gl_Position = u_mvp * vec4(a_pos, 1.0);
  gl_PointSize = a_shape.x * u_dpr;
  v_color = a_color;
  v_kind = a_shape.y;
}`;

const OVERLAY_FS = `#version 300 es
precision mediump float;
uniform int u_points;
in vec4 v_color;
in float v_kind;
out vec4 o_color;
void main() {
  float a = v_color.a;
  if (u_points == 1) {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r = length(c);
    if (r > 1.0) discard;
    if (v_kind < 0.5) a *= 1.0 - smoothstep(0.7, 1.0, r);
    else if (v_kind < 1.5) a *= exp(-r * r * 5.0);
    else a *= smoothstep(0.62, 0.74, r) * (1.0 - smoothstep(0.86, 1.0, r));
  }
  o_color = vec4(v_color.rgb * a, a);
}`;

type Mat4 = Float32Array;

const perspective = (fovy: number, aspect: number, near: number, far: number): Mat4 => {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
};

const lookAt = (eye: number[], target: number[], up: number[]): Mat4 => {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  const zl = Math.hypot(zx, zy, zz) || 1;
  zx /= zl;
  zy /= zl;
  zz /= zl;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  const xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl;
  xy /= xl;
  xz /= xl;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return new Float32Array([
    xx,
    yx,
    zx,
    0,
    xy,
    yy,
    zy,
    0,
    xz,
    yz,
    zz,
    0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
};

const invert = (m: Mat4): Mat4 => {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  const inv = det ? 1 / det : 0;
  return new Float32Array([
    (a11 * b11 - a12 * b10 + a13 * b09) * inv,
    (a02 * b10 - a01 * b11 - a03 * b09) * inv,
    (a31 * b05 - a32 * b04 + a33 * b03) * inv,
    (a22 * b04 - a21 * b05 - a23 * b03) * inv,
    (a12 * b08 - a10 * b11 - a13 * b07) * inv,
    (a00 * b11 - a02 * b08 + a03 * b07) * inv,
    (a32 * b02 - a30 * b05 - a33 * b01) * inv,
    (a20 * b05 - a22 * b02 + a23 * b01) * inv,
    (a10 * b10 - a11 * b08 + a13 * b06) * inv,
    (a01 * b08 - a00 * b10 - a03 * b06) * inv,
    (a30 * b04 - a31 * b02 + a33 * b00) * inv,
    (a21 * b02 - a20 * b04 - a23 * b00) * inv,
    (a11 * b07 - a10 * b09 - a12 * b06) * inv,
    (a00 * b09 - a01 * b07 + a02 * b06) * inv,
    (a31 * b01 - a30 * b03 - a32 * b00) * inv,
    (a20 * b03 - a21 * b01 + a22 * b00) * inv,
  ]);
};

const multiply = (a: Mat4, b: Mat4): Mat4 => {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
};

export const toDisplay = (u: number, v: number, frame: Frame): [number, number] => {
  let p: [number, number] = [u, v];
  if (frame.orientation === 1) p = [1 - v, u];
  else if (frame.orientation === 2) p = [1 - u, 1 - v];
  else if (frame.orientation === 3) p = [v, 1 - u];
  if (frame.flipH) p[0] = 1 - p[0];
  if (frame.flipV) p[1] = 1 - p[1];
  return p;
};

export const fromDisplay = (x: number, y: number, frame: Frame): [number, number] => {
  const p: [number, number] = [frame.flipH ? 1 - x : x, frame.flipV ? 1 - y : y];
  if (frame.orientation === 1) return [p[1], 1 - p[0]];
  if (frame.orientation === 2) return [1 - p[0], 1 - p[1]];
  if (frame.orientation === 3) return [1 - p[1], p[0]];
  return p;
};

const compile = (gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram => {
  const program = gl.createProgram()!;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(
        gl.getShaderInfoLog(shader) ||
          (gl.isContextLost() ? 'WebGL context lost' : 'Depth scope shader failed to compile'),
      );
    }
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'Depth scope program failed to link');
  }
  return program;
};

const uniformLocations = (gl: WebGL2RenderingContext, program: WebGLProgram) => {
  const map = new Map<string, WebGLUniformLocation | null>();
  return (name: string) => {
    if (!map.has(name)) map.set(name, gl.getUniformLocation(program, name));
    return map.get(name)!;
  };
};

export class DepthScopeRenderer {
  private gl: WebGL2RenderingContext;
  private pointProgram: WebGLProgram;
  private overlayProgram: WebGLProgram;
  private pointUniform: (name: string) => WebGLUniformLocation | null;
  private overlayUniform: (name: string) => WebGLUniformLocation | null;
  private emptyVao: WebGLVertexArrayObject;
  private overlayVao: WebGLVertexArrayObject;
  private overlayBuffer: WebGLBuffer;
  private colorTexture: WebGLTexture;
  private normalTexture: WebGLTexture;
  private preview: DepthPreview | null = null;
  private mvp: Mat4 = new Float32Array(16);
  private inverse: Mat4 = new Float32Array(16);
  private eye: [number, number, number] = [0, 0, 1];
  private target: [number, number, number] = [0, 0, 0];
  private viewport = { width: 1, height: 1, dpr: 1 };

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: true,
      premultipliedAlpha: true,
      depth: true,
      powerPreference: 'low-power',
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.pointProgram = compile(gl, POINT_VS, POINT_FS);
    this.overlayProgram = compile(gl, OVERLAY_VS, OVERLAY_FS);
    this.pointUniform = uniformLocations(gl, this.pointProgram);
    this.overlayUniform = uniformLocations(gl, this.overlayProgram);
    this.emptyVao = gl.createVertexArray()!;
    this.colorTexture = this.createTexture();
    this.normalTexture = this.createTexture();

    this.overlayVao = gl.createVertexArray()!;
    this.overlayBuffer = gl.createBuffer()!;
    gl.bindVertexArray(this.overlayVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayBuffer);
    const stride = 9 * 4;
    const attributes: Array<[string, number, number]> = [
      ['a_pos', 3, 0],
      ['a_color', 4, 12],
      ['a_shape', 2, 28],
    ];
    for (const [name, size, offset] of attributes) {
      const location = gl.getAttribLocation(this.overlayProgram, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
    }
    gl.bindVertexArray(null);
  }

  private createTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  setPreview(preview: DepthPreview) {
    const gl = this.gl;
    this.preview = preview;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      preview.width,
      preview.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      preview.pixels,
    );
    gl.bindTexture(gl.TEXTURE_2D, this.normalTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      preview.normals ? preview.width : 1,
      preview.normals ? preview.height : 1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      preview.normals ?? new Uint8Array([128, 128, 0, 255]),
    );
  }

  resize(width: number, height: number, dpr: number) {
    const canvas = this.gl.canvas as HTMLCanvasElement;
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    this.viewport = { width, height, dpr };
  }

  extent(frame: Frame): [number, number] {
    if (!this.preview) return [1, 1];
    const { width, height } = this.preview;
    const [w, h] = frame.orientation % 2 === 1 ? [height, width] : [width, height];
    const long = Math.max(w, h);
    return [w / long, h / long];
  }

  effectAspect(): [number, number] {
    if (!this.preview) return [1, 1];
    const { width, height } = this.preview;
    const long = Math.max(width, height);
    return [width / long, height / long];
  }

  updateCamera(camera: Camera, frame: Frame, front = 0) {
    const [ex, ey] = this.extent(frame);
    const aspect = this.viewport.width / Math.max(this.viewport.height, 1);
    const span = DEPTH_SCALE * (1 + front);
    const radius = 0.5 * Math.hypot(ex, ey, span) * (front > 0 ? 0.8 : 0.74);
    const halfFov = Math.min(FOV / 2, Math.atan(Math.tan(FOV / 2) * aspect));
    const distance = radius / Math.sin(halfFov) / camera.zoom;
    const target: [number, number, number] = [
      camera.offset[0],
      camera.offset[1],
      DEPTH_SCALE * (front - 1) * 0.5 + camera.offset[2],
    ];
    const eye: [number, number, number] = [
      target[0] + distance * Math.sin(camera.yaw) * Math.cos(camera.pitch),
      target[1] + distance * Math.sin(camera.pitch),
      target[2] + distance * Math.cos(camera.yaw) * Math.cos(camera.pitch),
    ];
    const projection = perspective(FOV, aspect, 0.05, 20);
    this.mvp = multiply(projection, lookAt(eye, target, [0, 1, 0]));
    this.inverse = invert(this.mvp);
    this.eye = eye;
    this.target = target;
  }

  pivot(): [number, number, number] {
    return this.target;
  }

  focusPoint(sx: number, sy: number): { point: [number, number, number]; target: [number, number, number] } | null {
    const { origin, direction } = this.ray(sx, sy);
    const n = [this.eye[0] - this.target[0], this.eye[1] - this.target[1], this.eye[2] - this.target[2]];
    const denom = direction[0] * n[0] + direction[1] * n[1] + direction[2] * n[2];
    if (Math.abs(denom) < 1e-9) return null;
    const t =
      ((this.target[0] - origin[0]) * n[0] +
        (this.target[1] - origin[1]) * n[1] +
        (this.target[2] - origin[2]) * n[2]) /
      denom;
    return {
      point: [origin[0] + direction[0] * t, origin[1] + direction[1] * t, origin[2] + direction[2] * t],
      target: this.target,
    };
  }

  ray(sx: number, sy: number): { origin: [number, number, number]; direction: [number, number, number] } {
    const nx = (sx / this.viewport.width) * 2 - 1;
    const ny = 1 - (sy / this.viewport.height) * 2;
    const m = this.inverse;
    const at = (nz: number): [number, number, number] => {
      const x = m[0] * nx + m[4] * ny + m[8] * nz + m[12];
      const y = m[1] * nx + m[5] * ny + m[9] * nz + m[13];
      const z = m[2] * nx + m[6] * ny + m[10] * nz + m[14];
      const w = m[3] * nx + m[7] * ny + m[11] * nz + m[15] || 1;
      return [x / w, y / w, z / w];
    };
    const near = at(-1);
    const far = at(1);
    return { origin: near, direction: [far[0] - near[0], far[1] - near[1], far[2] - near[2]] };
  }

  pixelsPerUnit(x: number, y: number, z: number): number {
    const m = this.mvp;
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    return this.viewport.height / 2 / Math.tan(FOV / 2) / Math.max(cw, 1e-4);
  }

  project(x: number, y: number, z: number): [number, number, number] {
    const m = this.mvp;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    const w = Math.max(cw, 1e-4);
    return [((cx / w) * 0.5 + 0.5) * this.viewport.width, (0.5 - (cy / w) * 0.5) * this.viewport.height, cw];
  }

  render(frame: Frame, uniforms: PointUniforms, overlay: Overlay) {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    if (this.preview) this.renderPoints(frame, uniforms);
    this.renderOverlay(overlay);
  }

  private renderPoints(frame: Frame, uniforms: PointUniforms) {
    const gl = this.gl;
    const preview = this.preview!;
    const u = this.pointUniform;
    gl.useProgram(this.pointProgram);
    gl.bindVertexArray(this.emptyVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
    gl.uniform1i(u('u_color'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.normalTexture);
    gl.uniform1i(u('u_normal'), 1);

    const [ex, ey] = this.extent(frame);
    const cell = ex / (frame.orientation % 2 === 1 ? preview.height : preview.width);
    const focal = this.viewport.height / 2 / Math.tan(FOV / 2);
    gl.uniform2i(u('u_size'), preview.width, preview.height);
    gl.uniformMatrix4fv(u('u_mvp'), false, this.mvp);
    gl.uniform2f(u('u_extent'), ex, ey);
    gl.uniform2f(u('u_effectAspect'), ...this.effectAspect());
    gl.uniform3i(u('u_frame'), frame.orientation, frame.flipH ? 1 : 0, frame.flipV ? 1 : 0);
    gl.uniform1f(u('u_pointScale'), focal * cell * 1.7 * this.viewport.dpr);
    gl.uniform1f(u('u_reveal'), uniforms.reveal);
    gl.uniform1i(u('u_mode'), uniforms.mode);

    const lens = uniforms.lens;
    gl.uniform4f(u('u_lens'), lens?.min ?? 0, lens?.max ?? 1, lens?.minFade ?? 0, lens?.maxFade ?? 0);
    gl.uniform1f(u('u_lensAmount'), lens?.amount ?? 0);
    const fog = uniforms.fog;
    gl.uniform4f(u('u_fog'), fog?.amount ?? 0, fog?.start ?? 0, fog?.density ?? 0, fog?.height ?? 0);
    gl.uniform3f(u('u_fogColor'), ...(fog?.color ?? [1, 1, 1]));
    const relight = uniforms.relight;
    gl.uniform3f(u('u_relight'), relight?.ambientGain ?? 1, relight?.softness ?? 0, relight?.count ?? 0);
    if (relight) gl.uniform4fv(u('u_lights'), relight.lights);
    const motion = uniforms.motion;
    gl.uniform4f(
      u('u_motion'),
      motion?.amount ?? 0,
      motion?.parallax ?? 0,
      motion?.reference ?? 0.5,
      motion?.radial ? 1 : 0,
    );
    gl.uniform2f(u('u_motionAxis'), ...(motion?.axis ?? [1, 0]));
    const contour = uniforms.contour;
    gl.uniform4f(u('u_contour'), contour?.depths[0] ?? 0, contour?.depths[1] ?? 0, contour?.strength ?? 0, 0);
    gl.uniform3f(u('u_accent'), ...(contour?.color ?? [1, 1, 1]));

    const count = preview.width * preview.height;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.uniform1i(u('u_ghost'), 0);
    gl.drawArrays(gl.POINTS, 0, count);
    if (uniforms.mode === MODE_MOTION && motion && motion.amount > 0) {
      gl.depthMask(false);
      gl.uniform1i(u('u_ghost'), 1);
      gl.drawArraysInstanced(gl.POINTS, 0, count, 4);
    }
    gl.bindVertexArray(null);
  }

  private renderOverlay(overlay: Overlay) {
    const gl = this.gl;
    const u = this.overlayUniform;
    gl.useProgram(this.overlayProgram);
    gl.bindVertexArray(this.overlayVao);
    gl.uniformMatrix4fv(u('u_mvp'), false, this.mvp);
    gl.uniform1f(u('u_dpr'), this.viewport.dpr);
    gl.depthMask(false);

    const draw = (data: number[], mode: number, points: boolean, depthTest: boolean) => {
      if (!data.length) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
      gl.uniform1i(u('u_points'), points ? 1 : 0);
      if (depthTest) gl.enable(gl.DEPTH_TEST);
      else gl.disable(gl.DEPTH_TEST);
      gl.drawArrays(mode, 0, data.length / 9);
    };

    draw(overlay.triangles, gl.TRIANGLES, false, true);
    draw(overlay.lines, gl.LINES, false, false);
    draw(overlay.points, gl.POINTS, true, false);
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteProgram(this.pointProgram);
    gl.deleteProgram(this.overlayProgram);
    gl.deleteTexture(this.colorTexture);
    gl.deleteTexture(this.normalTexture);
    gl.deleteBuffer(this.overlayBuffer);
    gl.deleteVertexArray(this.emptyVao);
    gl.deleteVertexArray(this.overlayVao);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
