import type { SiriBands, SiriSurface } from "./state";

export const VERTEX_SHADER = `#version 300 es
precision highp float;
const vec2 POSITIONS[3] = vec2[3](
  vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0)
);
void main() { gl_Position = vec4(POSITIONS[gl_VertexID], 0.0, 1.0); }
`;

export const WAVE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform vec4 uMouse;
uniform float uResolved;
uniform float uLayerOpacity;
uniform float uUnresolvedScale;
uniform float uEffectScale;
uniform vec2 uAnchor;
uniform float uAmplitude;
uniform float uFreq;
uniform float uAberrationFreq;
uniform float uWavePhase;
uniform float uWaveSpeed;
uniform float uWaveScale;
uniform float uAberration;
uniform float uThickness;
uniform float uIntensity;
uniform float uFalloff;
uniform float uEdgeMask;
uniform float uEdgeMaskInset;
uniform float uBandFill;
uniform float uBandFillThickness;
uniform float uSoftness;
uniform float uLow;
uniform float uMid;
uniform float uHigh;
uniform float uLowAmplitude;
uniform float uLowIntensity;
uniform float uMidAberration;
uniform float uMidAberrationAmplitude;
uniform float uMidBandFill;
uniform float uMidSoftness;
uniform float uHighAberration;
uniform float uHighAberrationAmplitude;
uniform float uWhiteClip;
out vec4 outColor;

float saturate(float value) { return clamp(value, 0.0, 1.0); }
const vec3 WAVE_TURQUOISE = vec3(0.0, 0.88, 1.0);
const vec3 WAVE_ICE_WHITE = vec3(0.82, 0.96, 1.0);
vec3 spectrumTri(float t) {
  vec3 blue = vec3(0.0, 0.412, 1.0);
  vec3 teal = vec3(0.0, 0.706, 0.710);
  vec3 green = vec3(0.0, 1.0, 0.416);
  if (t < 0.5) return blue;
  if (t < 1.5) return teal;
  if (t < 2.5) return green;
  return teal;
}
float smoothUnit(float value) { return value * value * (3.0 - 2.0 * value); }

void main() {
  vec2 gid = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  float tw = mod(uWavePhase, 62.831848) * uWaveSpeed;
  float lo = saturate(uLow);
  float md = saturate(uMid);
  float hi = saturate(uHigh);
  float res = saturate(uResolved);
  float c52 = uThickness * 0.01;
  float c55 = (lo * uLowIntensity + uIntensity) * 0.01;
  float c58 = max(0.0, md * uMidSoftness + uSoftness);
  float c61 = (md * uMidBandFill + uBandFill) * 0.0001;
  float c64 = (uLowAmplitude * 0.01) * lo + uAmplitude;
  float c68 = c64 + md * uMidAberrationAmplitude + hi * uHighAberrationAmplitude;
  float c72 = (md * uMidAberration + uAberration) + hi * uHighAberration;
  float c73 = c72 * res;
  float c76 = lo * 14.0;
  float c75 = md * 10.0 + 4.0;
  float n77 = mix(0.1, c52, res);
  float n78 = mix(0.1, c55, res);
  float n80 = (res * 0.01) * c58;
  float n81 = mix(c75, 1.0, res);
  float omr = 1.0 - res;

  vec2 uv = (gid + 0.5) * 2.0 / uResolution - 1.0;
  float aspect = uResolution.x / uResolution.y;
  uv.x *= aspect;
  vec2 q = uv - vec2(aspect, 1.0) * (uAnchor * 2.0 - 1.0);
  float ws = max(uWaveScale * uEffectScale, 0.01);
  vec2 p = q / ws;
  float base = mix(0.14, uUnresolvedScale, res);
  float r = length(p);
  float edge = max(r - base, 0.0);
  float aC = max(aspect, 1.0);
  float px = p.x / aC;
  float cw = min(abs(px * 0.9), 1.0);
  float cw2 = pow(cos(cw * 1.5707964), 2.0);
  float eps = 0.0001;
  float atArg = atan(px * eps) * aC / eps;
  float waveBase = (cw2 * res * c68) * sin(atArg * uFreq + tw);
  float negBase = -c73;
  float atArg2 = atArg * uAberrationFreq + tw;
  float py = p.y;
  float n80sq = n80 * n80;
  float bft = max(uBandFillThickness, 0.0001);
  float n139 = (c61 * res) * n78;
  float env68 = cw2 * c68;
  vec2 mouseUv = uMouse.xy / max(uResolution, vec2(1.0));
  float mouseLift = uMouse.z * 0.035 * exp(-pow((mouseUv.x * 2.0 - 1.0) * 2.4, 2.0));

  vec3 colAcc = vec3(0.0);
  vec3 wSum = vec3(0.0);
  for (int i = 0; i < 4; i += 1) {
    float fi = float(i);
    float t13 = fi * 0.33333334;
    // Geometry and opacity may resolve from 0 to 1, but the palette must not.
    // Mixing from white here caused the visible pastel flash after an answer.
    vec3 hue = spectrumTri(fi);
    wSum += hue;
    float ph = atArg2 + mix(negBase, c73, t13);
    float w2 = env68 * sin(ph) + mouseLift;
    float dist = mix(edge, abs(py - w2), res);
    float rad = sqrt(dist * dist + n80sq) + n77;
    float k = dist * 0.02;
    float soft = mix(1.0 / (k * k + 1.0), 1.0, res);
    float glowL = (soft * n78) / rad;
    float band = max(0.0, max(py - max(waveBase, w2), min(waveBase, w2) - py));
    float fill = n139 / (band + bft);
    colAcc += (hue * n81) * (fill + glowL);
  }
  vec3 col = colAcc / max(wSum, vec3(0.0001));
  float tail = omr * (c76 + 4.0);
  float dC = mix(edge, abs(py - waveBase), res);
  float radC = dC + n77;
  float kC = dC * 0.02;
  float softC = mix(1.0 / (kC * kC + 1.0), 1.0, res);
  float cg = (n78 * 0.5 * (softC + tail)) / radC;
  vec3 cgl = pow(vec3(cg) + col, vec3(1.5));
  float glowEnergy = max(max(cgl.r, cgl.g), cgl.b);
  float iceWhiteMix = smoothstep(0.35, 0.95, saturate(glowEnergy));
  cgl = mix(WAVE_TURQUOISE, WAVE_ICE_WHITE, iceWhiteMix) * glowEnergy;
  float ndcY = gid.y * 2.0 / uResolution.y - 1.0;
  float emC = max(clamp(uEdgeMask, 0.0, 1.0), 0.0001);
  float emMask = clamp((abs(ndcY) - 1.0 + clamp(uEdgeMaskInset, 0.0, 1.0)) / (-emC), 0.0, 1.0);
  emMask = smoothUnit(emMask);
  float fall = exp(-pow(px * uFalloff, 2.0));
  col = cgl * mix(1.0, emMask * fall, res) * res * saturate(uLayerOpacity);
  float m = max(max(col.r, col.g), col.b);
  vec3 huePreserved = col * ((m > 1.0) ? (1.0 / m) : 1.0);
  col = mix(huePreserved, min(col, vec3(1.0)), clamp(uWhiteClip, 0.0, 1.0));
  float alpha = saturate(max(max(col.r, col.g), col.b) * 1.15);
  outColor = vec4(col, alpha);
}
`;

export const DOTS_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform vec4 uMouse;
uniform float uDotsResolved;
uniform float uEffectScale;
uniform vec2 uAnchor;
uniform float uRotation;
uniform float uRingRadius;
uniform float uDotRadius;
uniform float uPairOffset;
uniform float uPairSmoothness;
uniform float uSmoothness;
uniform float uProgress0;
uniform float uProgress1;
uniform float uProgress2;
uniform float uProgress3;
uniform float uProgress4;
uniform float uProgress5;
uniform float uScaleDuration;
uniform float uScaleStagger;
uniform float uScaleMin;
uniform float uScaleMax;
uniform float uGlowIntensity;
uniform float uFalloffPower;
uniform float uGlowFadeStart;
uniform float uGlowFadeEnd;
uniform float uDotsAberration;
uniform float uCenterCore;
uniform float uDotsScale;
uniform float uAppear;
uniform float uGather;
uniform float uCharge;
uniform float uFlash;
out vec4 outColor;

float saturate(float value) { return clamp(value, 0.0, 1.0); }
vec3 spectrumTri(float t) {
  return clamp(vec3(abs(t - 3.0) - 1.0, 2.0 - abs(t - 2.0), 2.0 - abs(t - 4.0)), 0.0, 1.0);
}
float progressAt(int index) {
  if (index == 0) return uProgress0;
  if (index == 1) return uProgress1;
  if (index == 2) return uProgress2;
  if (index == 3) return uProgress3;
  if (index == 4) return uProgress4;
  return uProgress5;
}
float dotsField(
  vec2 P, vec2 aberOff, vec2 centersA[6], vec2 centersB[6],
  vec2 dirs[6], float radii[6], bool psOn, bool smOn,
  float pairSmooth, float smoothness, float pairK, float smK
) {
  float field = 1.0e9;
  for (int j = 0; j < 6; j += 1) {
    vec2 ofs = aberOff * dirs[j];
    float lenA = length(P + ofs - centersA[j]);
    float lenB = length(P + ofs - centersB[j]);
    float dA = lenA - radii[j];
    float dB = lenB - radii[j];
    float dPair = min(dA, dB);
    if (psOn) {
      float h = max(pairSmooth - abs(lenA - lenB), 0.0) / pairSmooth;
      dPair = min(dA, dB) - h * h * pairK;
    }
    if (smOn) {
      float h2 = max(smoothness - abs(field - dPair), 0.0) / smoothness;
      field = min(field, dPair) - h2 * h2 * smK;
    } else {
      field = min(field, dPair);
    }
  }
  return field;
}

void main() {
  vec2 gid = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  float mn = min(uResolution.x, uResolution.y);
  float halfMn = mn * 0.5;
  vec2 anchorC = uAnchor - 0.5;
  float aspect2 = uResolution.x / halfMn;
  vec2 anchorShift = vec2(aspect2, 2.0) * anchorC;
  float pr = max(uDotsScale * uEffectScale, 0.001);
  float drive = mod(uTime, 62.831848) * uRotation;
  float scaleDur = max(uScaleDuration, 0.001);
  float appear = saturate(uAppear) * saturate(uDotsResolved);
  float ringAmp = appear * uRingRadius;
  float pairAmp = appear * uPairOffset;
  vec2 centersA[6];
  vec2 centersB[6];
  vec2 dirs[6];
  float radii[6];

  for (int i = 0; i < 6; i += 1) {
    float fi = float(i);
    float angle = fi * 1.0471976 + drive;
    float ca = cos(angle);
    float sa = sin(angle);
    vec2 perp = vec2(-sa, ca);
    float fr = fract((fi * uScaleStagger + uTime) / scaleDur);
    float tri = 1.0 - abs(fr * 2.0 - 1.0);
    float x = saturate(tri);
    for (int k = 0; k < 8; k += 1) {
      float omx = 1.0 - x;
      float a3 = omx * 3.0;
      float c126 = (omx * 0.42) * a3;
      float x2 = x * x;
      float deriv = (x2 * 1.26) + (x * 0.96) * omx + c126;
      if (abs(deriv) < 0.000001) break;
      float num = ((x2 * 0.58) * a3 - tri) + (c126 + x2) * x;
      x = saturate(x - num / deriv);
    }
    float ss = x * x * (3.0 - 2.0 * x);
    float amp = mix(uScaleMin, uScaleMax, ss);
    amp = mix(amp, 0.45, uGather) * (1.0 - 0.18 * saturate(uCharge));
    vec2 dir = vec2(ca, sa);
    vec2 base = (ringAmp * dir) * (1.0 - 2.0 * progressAt(i));
    base = mix(base, dir * 0.008, uGather);
    float ph2 = pairAmp * amp * (1.0 - uGather);
    centersA[i] = base - ph2 * perp;
    centersB[i] = base + ph2 * perp;
    dirs[i] = dir;
    radii[i] = amp * uDotRadius;
  }

  vec2 uvPix = (gid + 0.5 - 0.5 * uResolution) / halfMn;
  vec2 P = (uvPix - anchorShift) / pr;
  bool psOn = uPairSmoothness > 0.0001;
  bool smOn = uSmoothness > 0.0001;
  float fadeRange = max(uGlowFadeEnd - uGlowFadeStart, 0.0001);
  float aberStep = uDotsAberration * 0.0909090936;
  vec3 colAcc = vec3(0.0);
  vec3 wSum = vec3(0.0);
  for (int i = 0; i < 12; i += 1) {
    float ti = float(i) * 0.363636374;
    vec3 hue = spectrumTri(ti);
    vec2 aberOff = vec2(-(aberStep * float(i)));
    float field = dotsField(P, aberOff, centersA, centersB, dirs, radii,
      psOn, smOn, uPairSmoothness, uSmoothness,
      uPairSmoothness * 0.25, uSmoothness * 0.25);
    float fm = max(field, 0.0);
    float glow = saturate(uGlowIntensity / pow(fm + 0.0001, uFalloffPower));
    float fadeT = clamp((fm - uGlowFadeStart) / fadeRange, 0.0, 1.0);
    float fade = 1.0 - fadeT * fadeT * (3.0 - 2.0 * fadeT);
    colAcc += hue * (fade * glow);
    wSum += hue;
  }
  float cfield = dotsField(P, vec2(0.0), centersA, centersB, dirs, radii,
    psOn, smOn, uPairSmoothness, uSmoothness,
    uPairSmoothness * 0.25, uSmoothness * 0.25);
  vec3 col = colAcc / max(wSum, vec3(0.0001));
  float cfm = max(cfield, 0.0);
  float cglow = saturate(uGlowIntensity / pow(cfm + 0.0001, uFalloffPower));
  float cfadeT = clamp((cfm - uGlowFadeStart) / fadeRange, 0.0, 1.0);
  float cfade = 1.0 - cfadeT * cfadeT * (3.0 - 2.0 * cfadeT);
  vec2 mouseUv = uMouse.xy / max(uResolution, vec2(1.0));
  float mouseBoost = 1.0 + uMouse.z * 0.35 + uMouse.w * 0.2 +
    smoothstep(0.0, 0.16, 1.0 - distance(mouseUv, vec2(0.5))) * 0.05;
  col = (col + (cglow * uCenterCore) * cfade) * appear * mouseBoost;
  col *= mix(1.0, 0.85, saturate(uGather)) *
    (1.0 + 0.35 * saturate(uCharge) + 1.2 * uFlash);
  float m = max(max(col.r, col.g), col.b);
  col *= (m > 1.0) ? (1.0 / m) : 1.0;
  float alpha = saturate(max(max(col.r, col.g), col.b));
  outColor = vec4(col, alpha);
}
`;

export const BACKGROUND_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform sampler2D uBackground;
uniform vec2 uTextureSize;
uniform vec2 uCanvasSize;
uniform float uBackgroundReady;
out vec4 outColor;
vec2 coverUv(vec2 canvasUv) {
  vec2 pixel = canvasUv * uCanvasSize;
  float cover = max(uCanvasSize.x / uTextureSize.x, uCanvasSize.y / uTextureSize.y);
  vec2 fitted = uTextureSize * cover;
  vec2 offset = (fitted - uCanvasSize) * 0.5;
  return clamp((pixel + offset) / fitted, vec2(0.0), vec2(1.0));
}
vec3 fallbackBackground(vec2 uv) {
  float vignette = smoothstep(0.95, 0.12, distance(uv, vec2(0.5)));
  vec3 top = vec3(0.015, 0.018, 0.022);
  vec3 bottom = vec3(0.0, 0.0, 0.0);
  vec3 tint = mix(bottom, top, 1.0 - uv.y);
  return tint + vec3(0.02, 0.035, 0.055) * vignette;
}
void main() {
  vec2 pixel = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  vec2 uv = pixel / uCanvasSize;
  vec3 image = texture(uBackground, coverUv(uv)).rgb;
  vec3 background = mix(fallbackBackground(uv), image, clamp(uBackgroundReady, 0.0, 1.0));
  outColor = vec4(background, 1.0);
}
`;

export const EFFECT_COMPOSITE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform sampler2D uEffectTexture;
uniform vec2 uCanvasSize;
uniform vec2 uEffectOrigin;
uniform vec2 uEffectSize;
uniform float uContainer;
uniform float uContainerBlack;
uniform float uContainerFade;
uniform float uContainerGauss;
uniform vec3 uContainerTint;
uniform float uAnger;
out vec4 outColor;
void main() {
  vec2 pixel = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  vec2 effectUv = (pixel - uEffectOrigin) / uEffectSize;
  vec2 inRect = step(vec2(0.0), effectUv) * step(effectUv, vec2(1.0));
  if (inRect.x * inRect.y < 0.5) discard;
  vec4 effect = texture(uEffectTexture, vec2(effectUv.x, 1.0 - effectUv.y));
  float gy = clamp(effectUv.y, 0.0, 1.0);
  float t = clamp((gy - uContainerBlack) / max(uContainerFade, 0.001), 0.0, 1.0);
  float vfade = (gy <= uContainerBlack) ? 1.0 : exp(-uContainerGauss * t * t);
  float edgeLR = smoothstep(0.0, 0.14, min(effectUv.x, 1.0 - effectUv.x));
  float containerA = clamp(uContainer, 0.0, 1.0) * vfade * edgeLR;
  vec3 containerColor = mix(vec3(0.0), uContainerTint,
    clamp(uAnger, 0.0, 1.0) * vfade);
  float invEffectA = 1.0 - effect.a;
  vec3 outRGB = effect.rgb + containerColor * containerA * invEffectA;
  float outA = effect.a + containerA * invEffectA;
  outColor = vec4(outRGB, outA);
}
`;

export const GLASS_COMPOSITE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform sampler2D uSceneTexture;
uniform sampler2D uBackground;
uniform vec2 uTextureSize;
uniform vec2 uPanelSize;
uniform vec2 uCanvasSize;
uniform vec2 uPanelOrigin;
uniform float uMarginPx;
uniform float uCornerRadius;
uniform float uHeight;
uniform float uCurvature;
uniform float uRefractAmount;
uniform float uAngle;
uniform float uGradRadialMix;
uniform float uKeyAngle;
uniform float uFillAngle;
uniform float uHlHeight;
uniform float uHlCut;
uniform float uHlNorm;
uniform float uHlAmount;
uniform float uHlCurv;
uniform float uBackgroundReady;
uniform float uTransparentOutside;
uniform vec4 uChip0;
uniform vec4 uChip1;
uniform vec4 uChip2;
uniform vec3 uChipState;
uniform vec3 uChipHover;
uniform float uChipRefract;
uniform float uChipHeight;
uniform float uChipHlAmount;
uniform float uChipFace;
out vec4 outColor;

float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec2 rotate2d(vec2 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}
vec2 coverUv(vec2 canvasUv) {
  vec2 pixel = canvasUv * uCanvasSize;
  float cover = max(uCanvasSize.x / uTextureSize.x, uCanvasSize.y / uTextureSize.y);
  vec2 fitted = uTextureSize * cover;
  vec2 offset = (fitted - uCanvasSize) * 0.5;
  return clamp((pixel + offset) / fitted, vec2(0.0), vec2(1.0));
}
vec3 fallbackBackground(vec2 uv) {
  float vignette = smoothstep(0.95, 0.12, distance(uv, vec2(0.5)));
  vec3 top = vec3(0.015, 0.018, 0.022);
  vec3 bottom = vec3(0.0, 0.0, 0.0);
  return mix(bottom, top, 1.0 - uv.y) + vec3(0.02, 0.035, 0.055) * vignette;
}
vec3 sampleBackground(vec2 canvasUv) {
  vec3 image = texture(uBackground, coverUv(canvasUv)).rgb;
  return mix(fallbackBackground(canvasUv), image, clamp(uBackgroundReady, 0.0, 1.0));
}
vec3 sampleScene(vec2 canvasUv) {
  return texture(uSceneTexture, vec2(canvasUv.x, 1.0 - canvasUv.y)).rgb;
}
float supercircleDistance(vec2 p, vec2 b, float n, vec2 param) {
  const float c = 1.528665;
  float an = abs(n);
  float ac = an * c;
  float m10 = mix(ac, an, max(param.x, param.y));
  vec2 v14 = (p - b) + vec2(m10);
  vec2 q = abs(max(vec2(0.0), (p - b) / max(ac, 0.0001) + vec2(1.0)));
  float l = length(q);
  float qmax = max(q.x, q.y);
  float qmin = min(q.x, q.y);
  float ratio = (qmax == 0.0) ? 0.0 : saturate(qmin / qmax);
  float poly = ((((-0.926054 * ratio + 3.15601) * ratio - 3.64122) * ratio + 1.26803) * ratio + 0.268531);
  float dCorner = (l + 1.0) - 1.0 / (1.0 - ratio * ratio * saturate(l) * poly);
  float dFar = length(max(vec2(0.0), q * c - vec2(0.528665))) * 0.654166 + 0.345834;
  float d57 = mix(dCorner, dFar, param.x);
  float d58 = mix(dCorner, dFar, param.y);
  float s = (q.y > q.x) ? 1.0 : -1.0;
  float t65 = saturate((0.5 - s) + s * ratio);
  float dist = mix(d57, d58, t65) - 1.0;
  float emin = min(max(v14.x, v14.y), 0.0);
  return emin + ac * dist;
}
vec2 cornerParam(vec2 halfSize, float r) {
  if (r < 0.0001) return vec2(0.0);
  return clamp((vec2(1.528665) - halfSize / r) / 0.528665, vec2(0.0), vec2(1.0));
}
float shapeDistance(vec2 p, vec2 halfSize, float cornerRadius) {
  float r = min(cornerRadius, min(halfSize.x, halfSize.y));
  if (r < 0.5) {
    vec2 dd = abs(p) - halfSize;
    return length(max(dd, vec2(0.0))) + min(max(dd.x, dd.y), 0.0);
  }
  return supercircleDistance(abs(p), halfSize, r, cornerParam(halfSize, r));
}
vec2 shapeGradient(vec2 p, vec2 halfSize, float cornerRadius, float radialMix) {
  float r = min(cornerRadius, min(halfSize.x, halfSize.y));
  vec2 param = cornerParam(halfSize, r);
  float ac = mix(r * 1.528665, r, max(param.x, param.y));
  vec2 pf = abs(p);
  vec2 v = max(vec2(0.0), (pf - halfSize) + vec2(ac));
  vec2 g = (v.x + v.y > 0.00001)
    ? normalize(v)
    : ((pf.x - halfSize.x > pf.y - halfSize.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vec2 cornerGrad = g * sign(p);
  vec2 centerRadial = normalize(vec2(p.x, halfSize.x * p.y / max(halfSize.y, 0.001)) + vec2(0.00001));
  return normalize(mix(cornerGrad, centerRadial, radialMix));
}
float refractionProfile(float t, float curvature) {
  float flatProfile = 1.0 - 0.2929 * (t < 1.0 ? 1.0 : 0.0);
  float circular = sqrt(max(1.0 - (1.0 - t) * (1.0 - t), 0.0));
  return mix(flatProfile, circular, curvature);
}
vec2 refractedUv(vec2 baseUv, float d, vec2 grad) {
  float t = clamp(-d / max(uHeight, 0.001), 0.0, 1.0);
  float mag = 1.0 - refractionProfile(t, uCurvature);
  vec2 dir = rotate2d(grad, uAngle);
  return baseUv + (uRefractAmount * mag * dir) / uCanvasSize;
}
float highlightLobe(float dist, float aa, vec2 n, float h, vec2 dir, float cut, float curv) {
  if (dist < -5.0) return 0.0;
  float t = saturate(dist / max(h, 0.001));
  float profile = mix(t < 1.0 ? 1.0 : 0.0, 1.0 - t, curv);
  float band = saturate(dist / aa + 0.5) * saturate((h - dist) / aa + 0.5) * profile;
  float angular = saturate((dot(dir, n) - cut) / max(1.0 - cut, 0.001));
  return band * angular;
}
float highlightBand(float d, vec2 grad) {
  float glen = max(length(grad), 0.0001);
  float dist = -d / glen;
  vec2 n = grad / glen;
  float aa = max(fwidth(dist), 0.0001);
  vec2 kdir = vec2(cos(uKeyAngle), sin(uKeyAngle));
  vec2 fdir = vec2(cos(uFillAngle), sin(uFillAngle));
  float key = highlightLobe(dist, aa, n, uHlHeight, kdir, uHlCut, uHlCurv);
  float fill = highlightLobe(dist, aa, n, uHlHeight, fdir, uHlCut, uHlCurv);
  float keyN = key / (1.0 + (1.0 - key) * uHlNorm);
  float fillN = fill / (1.0 + (1.0 - fill) * uHlNorm);
  return keyN + fillN;
}
vec4 glassFragment(vec2 pixel) {
  vec2 panelUv = (pixel - uPanelOrigin) / uPanelSize;
  vec2 inQuad = step(vec2(0.0), panelUv) * step(panelUv, vec2(1.0));
  if (inQuad.x * inQuad.y < 0.5) return vec4(0.0);
  vec2 halfSize = uPanelSize * 0.5 - vec2(uMarginPx);
  vec2 p = (panelUv - vec2(0.5)) * uPanelSize;
  float d = shapeDistance(p, halfSize, uCornerRadius);
  float alpha = 1.0 - smoothstep(-1.0, 1.0, d);
  if (alpha <= 0.001) return vec4(0.0);
  vec2 grad = shapeGradient(p, halfSize, uCornerRadius, uGradRadialMix);
  vec2 baseUv = (uPanelOrigin + panelUv * uPanelSize) / uCanvasSize;
  vec2 rUv = clamp(refractedUv(baseUv, d, grad), vec2(0.0), vec2(1.0));
  vec3 col = sampleScene(rUv);
  col += vec3(highlightBand(d, grad) * uHlAmount);
  vec4 chips[3] = vec4[3](uChip0, uChip1, uChip2);
  for (int i = 0; i < 3; i++) {
    float on = uChipState[i];
    vec4 chip = chips[i];
    if (on <= 0.001 || chip.z <= 0.5) continue;
    vec2 cp = p - chip.xy;
    float cr = min(chip.z, chip.w);
    float cd = shapeDistance(cp, chip.zw, cr);
    float ca = (1.0 - smoothstep(-1.0, 1.0, cd)) * on;
    if (ca <= 0.001) continue;
    vec2 cgrad = shapeGradient(cp, chip.zw, cr, 0.35);
    float t = clamp(-cd / max(uChipHeight, 0.001), 0.0, 1.0);
    float mag = 1.0 - refractionProfile(t, 1.0);
    vec2 cUv = clamp(rUv + (uChipRefract * mag * cgrad) / uCanvasSize, vec2(0.0), vec2(1.0));
    float hov = uChipHover[i];
    vec3 chipCol = sampleScene(cUv);
    chipCol = mix(chipCol, vec3(1.0), uChipFace * (1.0 + 1.5 * hov));
    chipCol += vec3(highlightBand(cd, cgrad) * uChipHlAmount);
    col = mix(col, chipCol, ca);
  }
  return vec4(col, alpha);
}
void main() {
  vec2 pixel = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  vec2 canvasUv = pixel / uCanvasSize;
  vec3 background = sampleBackground(canvasUv);
  vec4 glass = glassFragment(pixel);
  float a = saturate(glass.a);
  vec3 glassRgb = clamp(glass.rgb, 0.0, 1.25);
  vec4 framed = vec4(mix(background, glassRgb, a), 1.0);
  vec4 floating = vec4(glassRgb * a, a);
  outColor = mix(framed, floating, clamp(uTransparentOutside, 0.0, 1.0));
}
`;

export interface UniformValue {
  name: string;
  type?: "float" | "vec2" | "vec3" | "vec4" | "int" | "bool" | "mat3" | "mat4";
  value: number | boolean | number[];
}

const BLOOM_PRESET = {
  audioScale: 1,
  uWhiteClip: 1,
  uUnresolvedScale: 0.14,
  uAmplitude: 0.22,
  uFreq: 1.1,
  uAberrationFreq: 1,
  uWaveSpeed: -1,
  uWaveScale: 0.9,
  uAberration: 2.6,
  uThickness: 3,
  uIntensity: 2,
  uFalloff: 1.7,
  uEdgeMask: 0.4,
  uEdgeMaskInset: 0,
  uBandFill: 30000,
  uBandFillThickness: 0.08,
  uSoftness: 2.5,
  uLowAmplitude: 6,
  uLowIntensity: 1.5,
  uMidAberration: 0.8,
  uMidAberrationAmplitude: 0.05,
  uMidBandFill: 0,
  uMidSoftness: 0.4,
  uHighAberration: 0.5,
  uHighAberrationAmplitude: 0.06,
} as const;

export function waveUniforms(surface: SiriSurface, bands: SiriBands): UniformValue[] {
  const { audioScale, ...values } = BLOOM_PRESET;
  return [
    { name: "uResolved", value: surface.sharedResolved },
    { name: "uLayerOpacity", value: surface.waveLayerOpacity },
    { name: "uEffectScale", value: surface.effectScale },
    { name: "uAnchor", type: "vec2", value: [0.5, 0.5] },
    { name: "uWavePhase", value: surface.wavePhase },
    { name: "uLow", value: bands.low * audioScale },
    { name: "uMid", value: bands.mid * audioScale },
    { name: "uHigh", value: bands.high * audioScale },
    ...Object.entries(values).map(([name, value]) => ({ name, value })),
  ];
}

export function dotsUniforms(
  surface: SiriSurface,
  progress: Array<{ value: number }>
): UniformValue[] {
  return [
    { name: "uDotsResolved", value: surface.dotsResolved },
    { name: "uEffectScale", value: surface.effectScale },
    { name: "uAnchor", type: "vec2", value: [0.5, 0.5] },
    { name: "uRotation", value: 0.7 },
    { name: "uRingRadius", value: 0.45 },
    { name: "uDotRadius", value: 0.1 },
    { name: "uPairOffset", value: 0.085 },
    { name: "uPairSmoothness", value: 0.2 },
    { name: "uSmoothness", value: 0.2 },
    ...progress.map((item, index) => ({
      name: `uProgress${index}`,
      value: item.value,
    })),
    { name: "uScaleDuration", value: 2 },
    { name: "uScaleStagger", value: 0.167 },
    { name: "uScaleMin", value: 0.001 },
    { name: "uScaleMax", value: 0.65 },
    { name: "uGlowIntensity", value: 0.04 },
    { name: "uFalloffPower", value: 0.7 },
    { name: "uGlowFadeStart", value: 0 },
    { name: "uGlowFadeEnd", value: 0.7 },
    { name: "uDotsAberration", value: -0.05 },
    { name: "uCenterCore", value: 0.5 },
    { name: "uDotsScale", value: 1 },
    { name: "uAppear", value: surface.dotsAppear },
    { name: "uGather", value: surface.gather },
    { name: "uCharge", value: surface.charge },
    { name: "uFlash", value: surface.flash },
  ];
}
