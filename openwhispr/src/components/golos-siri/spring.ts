export type SpringOptions =
  | { response: number; dampingRatio: number }
  | { duration: number; bounce: number }
  | { stiffness: number; damping: number; mass?: number };

const TAU = Math.PI * 2;
const MASS = 1;
const MIN_RESPONSE = 1e-4;

interface SpringParameters {
  mass: number;
  stiffness: number;
  damping: number;
  naturalAngularFrequency: number;
}

function paramsFromResponse(options: { response: number; dampingRatio: number }): SpringParameters {
  const response = Math.max(options.response, MIN_RESPONSE);
  const ratio = Math.max(0, options.dampingRatio);
  const omega = TAU / response;
  return {
    mass: MASS,
    stiffness: MASS * omega * omega,
    damping: 2 * ratio * MASS * omega,
    naturalAngularFrequency: omega,
  };
}

function normalizeOptions(options: SpringOptions): SpringParameters {
  if ("stiffness" in options) {
    const mass = options.mass || MASS;
    return {
      mass,
      stiffness: options.stiffness,
      damping: options.damping,
      naturalAngularFrequency: Math.sqrt(options.stiffness / mass),
    };
  }
  if ("duration" in options) {
    return paramsFromResponse({
      response: options.duration,
      dampingRatio: Math.max(0.05, 1 - Math.max(0, options.bounce)),
    });
  }
  return paramsFromResponse(options);
}

function stepSpring(
  value: number,
  velocity: number,
  target: number,
  params: SpringParameters,
  dt: number
): [number, number] {
  const omegaSq = params.stiffness / params.mass;
  const omega = params.naturalAngularFrequency;
  const decay = params.damping / (2 * params.mass);
  const t = Math.max(dt, 0);
  const x0 = value - target;

  if (t <= 0 || (x0 === 0 && velocity === 0)) {
    return [value, velocity];
  }

  let x: number;
  let v: number;
  if (decay < omega) {
    const wd = Math.sqrt(omegaSq - decay * decay);
    const envelope = Math.exp(-decay * t);
    const cos = Math.cos(wd * t);
    const sin = Math.sin(wd * t);
    const a = x0;
    const b = (velocity + decay * x0) / wd;
    const displacement = a * cos + b * sin;
    x = envelope * displacement;
    v = envelope * (-decay * displacement + (-a * wd * sin + b * wd * cos));
  } else if (omega < decay) {
    const wd = Math.sqrt(decay * decay - omegaSq);
    const r1 = -decay + wd;
    const r2 = -decay - wd;
    const a = (velocity - r2 * x0) / (r1 - r2);
    const b = x0 - a;
    const e1 = Math.exp(r1 * t);
    const e2 = Math.exp(r2 * t);
    x = a * e1 + b * e2;
    v = a * r1 * e1 + b * r2 * e2;
  } else {
    const envelope = Math.exp(-decay * t);
    const c = velocity + decay * x0;
    const displacement = x0 + c * t;
    x = envelope * displacement;
    v = envelope * (c - decay * displacement);
  }
  return [target + x, v];
}

export class Spring {
  value: number;
  velocity = 0;
  target: number;
  private parameters: SpringParameters;

  constructor(value: number, options: SpringOptions) {
    this.value = value;
    this.target = value;
    this.parameters = normalizeOptions(options);
  }

  setOptions(options: SpringOptions) {
    this.parameters = normalizeOptions(options);
  }

  setTarget(target: number, options?: SpringOptions) {
    if (options) this.setOptions(options);
    this.target = target;
  }

  jump(value: number) {
    this.value = value;
    this.velocity = 0;
    this.target = value;
  }

  step(dt: number) {
    [this.value, this.velocity] = stepSpring(
      this.value,
      this.velocity,
      this.target,
      this.parameters,
      dt
    );
    return this.value;
  }
}
