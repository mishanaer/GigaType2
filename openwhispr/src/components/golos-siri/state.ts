import { Spring } from "./spring";

export type SiriVisualState = "idle" | "listening" | "thinking" | "answer";

export interface SiriBands {
  low: number;
  mid: number;
  high: number;
}

export interface SiriSurface {
  waveOpacity: number;
  wavePhase: number;
  waveResolved: number;
  sharedResolved: number;
  dotsAppear: number;
  dotsResolved: number;
  effectScale: number;
  waveLayerOpacity: number;
  press: number;
  gather: number;
  charge: number;
  flash: number;
  answer: number;
}

const EXPANDED_WIDTH = 128 * 0.7;
const EXPANDED_HEIGHT = Math.round(EXPANDED_WIDTH * 0.7);

const WAVE_IN_SPRING = { response: 0.314, dampingRatio: 1 } as const;
const WAVE_OUT_SPRING = { response: 0.3, dampingRatio: 1 } as const;
const PRESS_SPRING = { response: 0.28, dampingRatio: 1 } as const;
const DOTS_APPEAR_SPRING = { response: 0.314, dampingRatio: 1 } as const;
const PROGRESS_SPRING = { duration: 0.9, bounce: 0.55 } as const;
const GATHER_IN_SPRING = { response: 0.5, dampingRatio: 1 } as const;
const GATHER_BURST_SPRING = { duration: 0.55, bounce: 0.5 } as const;
const CHARGE_SPRING = { response: 0.18, dampingRatio: 1 } as const;
const ANSWER_SPRING = { response: 0.5, dampingRatio: 0.8 } as const;

const PROGRESS_STAGGER_S = 0.2;
const FLIP_INTERVAL_S = 2.5;
const CONCLUDE_GATHER_S = 0.6;
const CONCLUDE_CHARGE_S = 0.3;
const FLASH_DECAY = 7;
const SIM_MAX_STEP_S = 1 / 30;
const WAVE_PHASE_WRAP = 62.831848;
const WAVE_SPEED_BASE = -2.5;
const WAVE_SPEED_AUDIO = -12;
const AUDIO_DRIVE_SCALE = 0.4;

const STATE_PRESETS: Record<SiriVisualState, { waveActive: boolean; fluidDotsActive: boolean }> = {
  idle: { waveActive: true, fluidDotsActive: false },
  listening: { waveActive: true, fluidDotsActive: false },
  thinking: { waveActive: false, fluidDotsActive: true },
  answer: { waveActive: false, fluidDotsActive: false },
};

function targetsFor(preset: (typeof STATE_PRESETS)[SiriVisualState]) {
  return {
    fluidDots: preset.fluidDotsActive ? 1 : -1,
    effectScale: preset.fluidDotsActive ? 2 / 3 : 1,
  };
}

function integrateFluidSim(
  sim: {
    current: { fluidDots: number; effectScale: number };
    velocity: { fluidDots: number; effectScale: number };
    target: { fluidDots: number; effectScale: number };
  },
  dt: number
) {
  let remaining = Math.min(Math.max(dt, 0), 0.1);
  while (remaining > 0) {
    const step = Math.min(remaining, SIM_MAX_STEP_S);
    for (const key of ["fluidDots", "effectScale"] as const) {
      const acceleration = (sim.current[key] - sim.target[key]) * -400 + sim.velocity[key] * -40;
      sim.velocity[key] += acceleration * step;
      sim.current[key] += sim.velocity[key] * step;
    }
    remaining -= step;
  }
}

function audioDrive(bands: SiriBands) {
  return Math.max(
    0,
    Math.min(1, Math.max(bands.low || 0, bands.mid || 0, bands.high || 0) * AUDIO_DRIVE_SCALE)
  );
}

export function createSiriState() {
  const initialTargets = targetsFor(STATE_PRESETS.idle);
  const surface: SiriSurface = {
    waveOpacity: 0,
    wavePhase: 0,
    waveResolved: -1,
    sharedResolved: 0,
    dotsAppear: 0,
    dotsResolved: initialTargets.fluidDots,
    effectScale: initialTargets.effectScale,
    waveLayerOpacity: 0,
    press: 0,
    gather: 0,
    charge: 0,
    flash: 0,
    answer: 0,
  };
  const springs = {
    waveOpacity: new Spring(0, WAVE_IN_SPRING),
    dotsAppear: new Spring(0, DOTS_APPEAR_SPRING),
    press: new Spring(0, PRESS_SPRING),
  };
  const sim = {
    current: { ...initialTargets },
    velocity: { fluidDots: 0, effectScale: 0 },
    target: { ...initialTargets },
  };
  const progress = Array.from({ length: 6 }, () => ({ value: 0 }));
  const progressSprings = progress.map(() => new Spring(0, PROGRESS_SPRING));
  const gatherSpring = new Spring(0, GATHER_IN_SPRING);
  const chargeSpring = new Spring(0, CHARGE_SPRING);
  const answerSpring = new Spring(0, ANSWER_SPRING);

  let state: SiriVisualState = "idle";
  let flipTarget = 0;
  let previousFlipTarget = 0;
  let thinkTimer = 0;
  let timeSinceFlip = Number.POSITIVE_INFINITY;
  let concludePhase: null | "gather" | "charge" = null;
  let concludeTimer = 0;
  let flashValue = 0;

  function resetFlip() {
    previousFlipTarget = 0;
    flipTarget = 0;
    thinkTimer = 0;
    timeSinceFlip = Number.POSITIVE_INFINITY;
    for (const spring of progressSprings) {
      spring.setTarget(0, PROGRESS_SPRING);
    }
  }

  function resetConclude() {
    concludePhase = null;
    concludeTimer = 0;
    flashValue = 0;
    gatherSpring.jump(0);
    gatherSpring.setOptions(GATHER_IN_SPRING);
    chargeSpring.jump(0);
  }

  return {
    sizes: {
      expanded: { width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT },
      answer: { width: 460, height: 150 },
    },
    surface,
    progress,
    get state() {
      return state;
    },
    select(name: SiriVisualState) {
      const preset = STATE_PRESETS[name];
      const targets = targetsFor(preset);
      const targetsChanged =
        sim.target.fluidDots !== targets.fluidDots ||
        sim.target.effectScale !== targets.effectScale;
      state = name;
      thinkTimer = 0;
      springs.waveOpacity.setTarget(
        preset.waveActive ? 1 : 0,
        preset.waveActive ? WAVE_IN_SPRING : WAVE_OUT_SPRING
      );
      sim.target = targets;
      if (targetsChanged) {
        sim.velocity = { fluidDots: 0, effectScale: 0 };
      }
      if (name !== "thinking") resetFlip();
      if (name === "listening" || name === "thinking") resetConclude();
      answerSpring.setTarget(name === "answer" ? 1 : 0, ANSWER_SPRING);
    },
    conclude() {
      if (state !== "thinking" || concludePhase) return 0;
      concludePhase = "gather";
      concludeTimer = 0;
      thinkTimer = 0;
      gatherSpring.setTarget(1, GATHER_IN_SPRING);
      return Math.round((CONCLUDE_GATHER_S + CONCLUDE_CHARGE_S) * 1000);
    },
    setPressed(pressed: boolean) {
      springs.press.setTarget(pressed ? 1 : 0, PRESS_SPRING);
    },
    tick(dt: number, bands: SiriBands) {
      surface.waveOpacity = springs.waveOpacity.step(dt);
      surface.press = springs.press.step(dt);
      integrateFluidSim(sim, dt);
      surface.dotsResolved = sim.current.fluidDots;
      surface.effectScale = sim.current.effectScale;
      surface.waveResolved = surface.waveOpacity * 2 - 1;
      surface.sharedResolved = Math.max(surface.waveResolved, surface.dotsResolved, 0);
      surface.waveLayerOpacity = 0.98 * Math.min(1, Math.max(0, surface.waveOpacity));
      const speed = WAVE_SPEED_BASE + WAVE_SPEED_AUDIO * audioDrive(bands);
      surface.wavePhase = (surface.wavePhase + speed * dt) % WAVE_PHASE_WRAP;
      if (surface.wavePhase < 0) surface.wavePhase += WAVE_PHASE_WRAP;

      springs.dotsAppear.setTarget(Math.max(surface.dotsResolved, 0), DOTS_APPEAR_SPRING);
      surface.dotsAppear = springs.dotsAppear.step(dt);

      if (concludePhase) {
        concludeTimer += dt;
        if (concludePhase === "gather" && concludeTimer >= CONCLUDE_GATHER_S) {
          concludePhase = "charge";
          chargeSpring.setTarget(1, CHARGE_SPRING);
        } else if (
          concludePhase === "charge" &&
          concludeTimer >= CONCLUDE_GATHER_S + CONCLUDE_CHARGE_S
        ) {
          concludePhase = null;
          flashValue = 1;
          gatherSpring.setTarget(0, GATHER_BURST_SPRING);
          chargeSpring.jump(0);
        }
      }
      surface.gather = gatherSpring.step(dt);
      surface.charge = chargeSpring.step(dt);
      surface.answer = answerSpring.step(dt);
      flashValue *= Math.exp(-FLASH_DECAY * dt);
      if (flashValue < 0.001) flashValue = 0;
      surface.flash = flashValue;

      if (state === "thinking" && surface.dotsResolved > 0) {
        if (!concludePhase) thinkTimer += dt;
        if (thinkTimer >= FLIP_INTERVAL_S) {
          thinkTimer = 0;
          previousFlipTarget = flipTarget;
          flipTarget = flipTarget > 0.5 ? 0 : 1;
          timeSinceFlip = 0;
        }
      } else {
        resetFlip();
      }

      timeSinceFlip += dt;
      for (let index = 0; index < progressSprings.length; index += 1) {
        const target = index * PROGRESS_STAGGER_S > timeSinceFlip ? previousFlipTarget : flipTarget;
        progressSprings[index].setTarget(target, PROGRESS_SPRING);
        progress[index].value = progressSprings[index].step(dt);
      }
    },
  };
}

export type SiriState = ReturnType<typeof createSiriState>;
