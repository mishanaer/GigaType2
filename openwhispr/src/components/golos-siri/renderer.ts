// The rendering math is adapted from the user's Siri reference component.
// @ts-nocheck
import type { SiriBands, SiriState } from "./state";
import {
  BACKGROUND_FRAGMENT_SHADER,
  DOTS_FRAGMENT_SHADER,
  EFFECT_COMPOSITE_FRAGMENT_SHADER,
  GLASS_COMPOSITE_FRAGMENT_SHADER,
  VERTEX_SHADER,
  WAVE_FRAGMENT_SHADER,
  DEFAULT_SIRI_WAVE_APPEARANCE,
  dotsUniforms,
  waveUniforms,
  type SiriWaveAppearance,
} from "./shaders";

const MAX_DPR = 2;
const PANEL_MARGIN_PX = 20;
const COMPACT_VISUAL_SCALE = 0.7;
const EFFECT_OVERDRAW = 1.18;
const CORNER_RADIUS_MAX_PX = 44;
const FALLBACK_PIXEL = new Uint8Array([3, 4, 8, 255]);
const BRIGHTNESS_ATTACK_S = 0.05;
const BRIGHTNESS_RELEASE_S = 0.05;

export interface SiriGlassMaterial {
  refractAmount: number;
  highlightHeight: number;
  highlightCut: number;
  highlightAmount: number;
}

export const DEFAULT_SIRI_GLASS_MATERIAL: SiriGlassMaterial = {
  refractAmount: -32,
  highlightHeight: 2.2,
  highlightCut: 0.52,
  highlightAmount: 0.72,
};

function cornerRadiusFor(coreWidth, coreHeight, answer, dpr) {
  const half = Math.min(coreWidth, coreHeight) * 0.5;
  const t = Math.max(0, Math.min(1, answer));
  const ceiling = half + (CORNER_RADIUS_MAX_PX * dpr - half) * t;
  return Math.min(half, ceiling);
}

function toNumberArray(value) {
  if (typeof value === "number" || typeof value === "boolean") {
    return [Number(value)];
  }
  if (Array.isArray(value)) return value.flat(Number.POSITIVE_INFINITY).map(Number);
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value, Number);
  }
  return [];
}

function inferUniformType(declared, value) {
  if (declared) return declared;
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return "float";
  const list = toNumberArray(value);
  if (list.length === 2) return "vec2";
  if (list.length === 3) return "vec3";
  if (list.length === 4) return "vec4";
  if (list.length === 9) return "mat3";
  if (list.length === 16) return "mat4";
  return "float";
}

function arraysEqual(a, b) {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function compileShader(gl, type, source, label) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`Unable to create ${label} shader.`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || `Unknown ${label} shader error.`;
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl, fragmentSource, label) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER, `${label} vertex`);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label} fragment`);
  const program = gl.createProgram();
  if (!program) throw new Error(`Unable to create ${label} program.`);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || `Unknown ${label} link error.`;
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return {
    label,
    program,
    uniforms: new Map(),
    types: new Map(),
    values: new Map(),
  };
}

function createLinearClampTexture(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return texture;
}

function createRenderTarget(gl, width, height) {
  const texture = createLinearClampTexture(gl);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    throw new Error("Siri framebuffer is incomplete.");
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { framebuffer, texture, width, height };
}

function destroyRenderTarget(gl, target) {
  if (!target) return;
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
}

export class SiriRenderer {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext | null;
  dpr = 1;
  width = 1;
  height = 1;
  time = 0;
  disposed = false;
  error: Error | null = null;
  panelOffset = [0, 0];
  backgroundSize = [1, 1];
  backgroundReady = 0;
  backgroundTexture = null;
  effectTarget = null;
  sceneTarget = null;
  vertexArray = null;
  programs = null;
  private contextLost = false;
  private lastImage: CanvasImageSource | null = null;
  private brightnessLow = 0;
  private onContextLost: (event: Event) => void;
  private onContextRestored: () => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    this.onContextLost = (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.effectTarget = null;
      this.sceneTarget = null;
    };
    this.onContextRestored = () => {
      try {
        this.contextLost = false;
        this.error = null;
        this.initGL();
      } catch (error) {
        this.fail(error);
      }
    };
    if (!this.gl) {
      this.fail(new Error("WebGL2 is unavailable."));
      return;
    }
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    try {
      this.initGL();
    } catch (error) {
      this.fail(error);
    }
  }

  private initGL() {
    const gl = this.gl;
    if (!gl) return;
    this.vertexArray = gl.createVertexArray();
    this.programs = {
      wave: createProgram(gl, WAVE_FRAGMENT_SHADER, "wave"),
      dots: createProgram(gl, DOTS_FRAGMENT_SHADER, "dots"),
      background: createProgram(gl, BACKGROUND_FRAGMENT_SHADER, "background"),
      effectComposite: createProgram(gl, EFFECT_COMPOSITE_FRAGMENT_SHADER, "effect composite"),
      glassComposite: createProgram(gl, GLASS_COMPOSITE_FRAGMENT_SHADER, "glass composite"),
    };
    this.backgroundTexture = createLinearClampTexture(gl);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, FALLBACK_PIXEL);
    gl.bindVertexArray(this.vertexArray);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    this.backgroundReady = 0;
    this.backgroundSize = [1, 1];
    if (this.lastImage) this.setBackgroundImage(this.lastImage);
  }

  setBackgroundImage(image: CanvasImageSource) {
    const gl = this.gl;
    this.lastImage = image;
    if (!gl || this.disposed || this.error || this.contextLost || !this.backgroundTexture) {
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    const sized = image as {
      naturalWidth?: number;
      naturalHeight?: number;
      width?: number;
      height?: number;
    };
    this.backgroundSize = [
      sized.naturalWidth || sized.width || 1,
      sized.naturalHeight || sized.height || 1,
    ];
    this.backgroundReady = 1;
  }

  render(
    state: Pick<SiriState, "surface" | "progress" | "sizes">,
    bands: SiriBands,
    dt = 0,
    glassMaterial = DEFAULT_SIRI_GLASS_MATERIAL,
    waveAppearance = DEFAULT_SIRI_WAVE_APPEARANCE
  ) {
    if (!this.gl || !this.programs || this.disposed || this.error || this.contextLost) {
      return;
    }
    this.time = (this.time + Math.max(0, Math.min(dt, 0.1))) % 1e5;
    const brightnessLow = this.updateBrightnessLow(
      bands.low,
      dt,
      waveAppearance.audioBrightnessSmoothing
    );
    this.resize();
    const layout = this.layout(state.surface, state.sizes);
    this.ensureTargets(layout);
    this.renderEffectPass(
      state.surface,
      state.progress,
      bands,
      brightnessLow,
      layout,
      waveAppearance
    );
    this.renderScenePass(layout);
    this.renderGlassPass(layout, glassMaterial);
  }

  dispose() {
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    const gl = this.gl;
    if (!gl || this.disposed) return;
    destroyRenderTarget(gl, this.effectTarget);
    destroyRenderTarget(gl, this.sceneTarget);
    if (this.backgroundTexture) gl.deleteTexture(this.backgroundTexture);
    for (const entry of Object.values(this.programs || {})) {
      gl.deleteProgram(entry.program);
    }
    if (this.vertexArray) gl.deleteVertexArray(this.vertexArray);
    this.effectTarget = null;
    this.sceneTarget = null;
    this.backgroundTexture = null;
    this.disposed = true;
  }

  private resize() {
    const cssWidth = Math.max(1, this.canvas.clientWidth || window.innerWidth || 1);
    const cssHeight = Math.max(1, this.canvas.clientHeight || window.innerHeight || 1);
    const dpr = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (width === this.width && height === this.height && dpr === this.dpr) return;
    this.dpr = dpr;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  private updateBrightnessLow(target, dt, shouldSmooth) {
    const clampedTarget = Math.max(0, Math.min(1, target || 0));
    const elapsed = Math.max(0, Math.min(dt, 0.1));
    if (!shouldSmooth || elapsed === 0) {
      this.brightnessLow = clampedTarget;
      return this.brightnessLow;
    }
    const timeConstant =
      clampedTarget > this.brightnessLow ? BRIGHTNESS_ATTACK_S : BRIGHTNESS_RELEASE_S;
    const blend = 1 - Math.exp(-elapsed / timeConstant);
    this.brightnessLow += (clampedTarget - this.brightnessLow) * blend;
    return this.brightnessLow;
  }

  private layout(surface, sizes) {
    const pressScale = 1 + surface.press * 0.018;
    const answer = surface.answer || 0;
    const settledAnswer = Math.max(0, Math.min(1, answer));
    const materialScale = COMPACT_VISUAL_SCALE + (1 - COMPACT_VISUAL_SCALE) * settledAnswer;
    const margin = PANEL_MARGIN_PX * this.dpr * materialScale;
    const baseWidth = sizes.expanded.width * this.dpr;
    const baseHeight = sizes.expanded.height * this.dpr;
    const thinkingMorph = Math.max(0, Math.min(1, ((surface.dotsResolved ?? -1) + 1) * 0.5));
    const stateWidth = baseWidth + (baseHeight - baseWidth) * thinkingMorph;
    const answerWidth = Math.min(sizes.answer.width * this.dpr, this.width - 48 * this.dpr);
    const answerHeight = sizes.answer.height * this.dpr;
    const coreWidth = (stateWidth + (answerWidth - stateWidth) * answer) * pressScale;
    const coreHeight = (baseHeight + (answerHeight - baseHeight) * answer) * pressScale;
    const panelWidth = coreWidth + margin * 2;
    const panelHeight = coreHeight + margin * 2;
    const effectWidth = Math.max(1, Math.round(coreWidth * EFFECT_OVERDRAW));
    const effectHeight = Math.max(1, Math.round(coreHeight * EFFECT_OVERDRAW));
    const panelX = (this.width - panelWidth) * 0.5 + this.panelOffset[0];
    const panelY = (this.height - panelHeight) * 0.5 + this.panelOffset[1];
    const panelCenterY = panelY + panelHeight * 0.5;
    return {
      effectWidth,
      effectHeight,
      effectOrigin: [
        (this.width - effectWidth) * 0.5 + this.panelOffset[0],
        panelCenterY - effectHeight * 0.5,
      ],
      effectSize: [effectWidth, effectHeight],
      panelOrigin: [panelX, panelY],
      panelSize: [panelWidth, panelHeight],
      margin,
      materialScale,
      cornerRadius: cornerRadiusFor(coreWidth, coreHeight, answer, this.dpr),
      containerStrength:
        0.9 * Math.min(1, Math.max(0, Math.max(surface.sharedResolved || 0, answer))),
    };
  }

  private ensureTargets(layout) {
    const gl = this.gl;
    if (
      !this.effectTarget ||
      this.effectTarget.width !== layout.effectWidth ||
      this.effectTarget.height !== layout.effectHeight
    ) {
      destroyRenderTarget(gl, this.effectTarget);
      this.effectTarget = createRenderTarget(gl, layout.effectWidth, layout.effectHeight);
    }
    if (
      !this.sceneTarget ||
      this.sceneTarget.width !== this.width ||
      this.sceneTarget.height !== this.height
    ) {
      destroyRenderTarget(gl, this.sceneTarget);
      this.sceneTarget = createRenderTarget(gl, this.width, this.height);
    }
  }

  private renderEffectPass(
    surface,
    progress,
    bands,
    brightnessLow,
    layout,
    waveAppearance: SiriWaveAppearance
  ) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.effectTarget.framebuffer);
    gl.viewport(0, 0, layout.effectWidth, layout.effectHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const shared = [
      {
        name: "uResolution",
        type: "vec2",
        value: [layout.effectWidth, layout.effectHeight],
      },
      { name: "uTime", value: this.time },
      {
        name: "uMouse",
        type: "vec4",
        value: [layout.effectWidth * 0.5, layout.effectHeight * 0.5, surface.press, 0],
      },
    ];
    this.draw(this.programs.wave, [
      ...shared,
      ...waveUniforms(surface, bands, waveAppearance, brightnessLow),
    ]);
    this.draw(this.programs.dots, [...shared, ...dotsUniforms(surface, progress)]);
    gl.disable(gl.BLEND);
  }

  private renderScenePass(layout) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneTarget.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.draw(
      this.programs.background,
      [
        { name: "uResolution", type: "vec2", value: [this.width, this.height] },
        { name: "uTextureSize", type: "vec2", value: this.backgroundSize },
        { name: "uCanvasSize", type: "vec2", value: [this.width, this.height] },
        { name: "uBackgroundReady", value: this.backgroundReady },
      ],
      [{ name: "uBackground", texture: this.backgroundTexture, unit: 0 }]
    );
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.draw(
      this.programs.effectComposite,
      [
        { name: "uResolution", type: "vec2", value: [this.width, this.height] },
        { name: "uCanvasSize", type: "vec2", value: [this.width, this.height] },
        { name: "uEffectOrigin", type: "vec2", value: layout.effectOrigin },
        { name: "uEffectSize", type: "vec2", value: layout.effectSize },
        { name: "uContainer", value: layout.containerStrength },
        { name: "uContainerBlack", value: 0.25 },
        { name: "uContainerFade", value: 1 },
        { name: "uContainerGauss", value: 8 },
        { name: "uContainerTint", type: "vec3", value: [0.36, 0.04, 0.05] },
        { name: "uAnger", value: 0 },
      ],
      [{ name: "uEffectTexture", texture: this.effectTarget.texture, unit: 0 }]
    );
    gl.disable(gl.BLEND);
  }

  private renderGlassPass(layout, glassMaterial: SiriGlassMaterial) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.draw(
      this.programs.glassComposite,
      [
        { name: "uResolution", type: "vec2", value: [this.width, this.height] },
        { name: "uTextureSize", type: "vec2", value: this.backgroundSize },
        { name: "uPanelSize", type: "vec2", value: layout.panelSize },
        { name: "uCanvasSize", type: "vec2", value: [this.width, this.height] },
        { name: "uPanelOrigin", type: "vec2", value: layout.panelOrigin },
        { name: "uMarginPx", value: layout.margin },
        { name: "uCornerRadius", value: layout.cornerRadius },
        { name: "uHeight", value: 18 * this.dpr * layout.materialScale },
        { name: "uCurvature", value: 1 },
        {
          name: "uRefractAmount",
          value: glassMaterial.refractAmount * this.dpr * layout.materialScale,
        },
        { name: "uAngle", value: 0 },
        { name: "uGradRadialMix", value: 0.08 },
        { name: "uKeyAngle", value: Math.PI * 0.25 },
        { name: "uFillAngle", value: Math.PI * 1.25 },
        {
          name: "uHlHeight",
          value: glassMaterial.highlightHeight * this.dpr * layout.materialScale,
        },
        { name: "uHlCut", value: glassMaterial.highlightCut },
        { name: "uHlNorm", value: 8 },
        { name: "uHlAmount", value: glassMaterial.highlightAmount },
        { name: "uHlCurv", value: 1 },
        { name: "uBackgroundReady", value: this.backgroundReady },
        { name: "uTransparentOutside", value: 1 },
        { name: "uChip0", type: "vec4", value: [0, 0, 0, 0] },
        { name: "uChip1", type: "vec4", value: [0, 0, 0, 0] },
        { name: "uChip2", type: "vec4", value: [0, 0, 0, 0] },
        { name: "uChipState", type: "vec3", value: [0, 0, 0] },
        { name: "uChipHover", type: "vec3", value: [0, 0, 0] },
        { name: "uChipRefract", value: -22 * this.dpr },
        { name: "uChipHeight", value: 7 * this.dpr },
        { name: "uChipHlAmount", value: 0.6 },
        { name: "uChipFace", value: 0.1 },
      ],
      [
        { name: "uSceneTexture", texture: this.sceneTarget.texture, unit: 0 },
        { name: "uBackground", texture: this.backgroundTexture, unit: 1 },
      ]
    );
  }

  private draw(programEntry, uniforms = [], textures = []) {
    const gl = this.gl;
    gl.useProgram(programEntry.program);
    gl.bindVertexArray(this.vertexArray);
    for (const binding of textures) {
      const location = this.getUniformLocation(programEntry, binding.name);
      if (location === null) continue;
      gl.activeTexture(gl.TEXTURE0 + binding.unit);
      gl.bindTexture(gl.TEXTURE_2D, binding.texture);
      gl.uniform1i(location, binding.unit);
    }
    for (const uniform of uniforms) {
      this.setUniform(programEntry, uniform.name, uniform.value, uniform.type);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private setUniform(programEntry, name, value, declaredType) {
    const gl = this.gl;
    const location = this.getUniformLocation(programEntry, name);
    if (location === null) return;
    let type = programEntry.types.get(name);
    if (type === undefined) {
      type = inferUniformType(declaredType, value);
      programEntry.types.set(name, type);
    }
    const list = toNumberArray(value);
    const previous = programEntry.values.get(name);
    if (previous !== undefined && previous.length === list.length && arraysEqual(previous, list)) {
      return;
    }
    programEntry.values.set(name, list);
    if (type === "int" || type === "sampler2D" || type === "bool") {
      gl.uniform1i(location, list[0] || 0);
    } else if (type === "vec2") {
      gl.uniform2fv(location, list.slice(0, 2));
    } else if (type === "vec3") {
      gl.uniform3fv(location, list.slice(0, 3));
    } else if (type === "vec4") {
      gl.uniform4fv(location, list.slice(0, 4));
    } else if (type === "mat3") {
      gl.uniformMatrix3fv(location, false, list.slice(0, 9));
    } else if (type === "mat4") {
      gl.uniformMatrix4fv(location, false, list.slice(0, 16));
    } else {
      gl.uniform1f(location, list[0] || 0);
    }
  }

  private getUniformLocation(programEntry, name) {
    if (programEntry.uniforms.has(name)) {
      return programEntry.uniforms.get(name);
    }
    const location = this.gl.getUniformLocation(programEntry.program, name);
    programEntry.uniforms.set(name, location);
    return location;
  }

  private fail(error: unknown) {
    this.error = error instanceof Error ? error : new Error(String(error));
    this.canvas.dataset.fallback = "true";
    this.canvas.dispatchEvent(
      new CustomEvent("siri-render-error", {
        detail: { message: this.error.message },
      })
    );
  }
}
