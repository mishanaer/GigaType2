import { useEffect, useRef } from "react";
import { SiriRenderer, type SiriGlassMaterial } from "./golos-siri/renderer";
import type { SiriWaveAppearance } from "./golos-siri/shaders";
import { createSiriState, type SiriBands } from "./golos-siri/state";

export type GolosCapsulePhase = "listening" | "transcribing";

interface GolosCapsuleProps {
  phase: GolosCapsulePhase;
  audioLevel?: number;
  timeScale?: number;
  glassMaterial?: SiriGlassMaterial;
  waveAppearance?: SiriWaveAppearance;
}

const SILENT_BANDS: SiriBands = { low: 0, mid: 0, high: 0 };

function bandsForLevel(level: number): SiriBands {
  const normalized = Math.max(0, Math.min(1, level));
  return {
    low: normalized,
    mid: Math.min(1, normalized * 0.82),
    high: Math.min(1, normalized * 0.58),
  };
}

/**
 * The compact SiriAI surface from Golos. Type already owns microphone capture,
 * so this adapter feeds the existing normalized audio level into the original
 * WebGL state machine instead of requesting a second MediaStream.
 */
export function GolosCapsule({
  phase,
  audioLevel = 0,
  timeScale = 1,
  glassMaterial,
  waveAppearance,
}: GolosCapsuleProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const siriRef = useRef<ReturnType<typeof createSiriState> | null>(null);
  const rendererRef = useRef<SiriRenderer | null>(null);
  const frameRef = useRef(0);
  const levelRef = useRef(audioLevel);
  const timeScaleRef = useRef(timeScale);
  const glassMaterialRef = useRef(glassMaterial);
  const waveAppearanceRef = useRef(waveAppearance);
  const reducedMotionRef = useRef(false);

  levelRef.current = audioLevel;
  timeScaleRef.current = Math.max(0.05, Math.min(4, timeScale));
  glassMaterialRef.current = glassMaterial;
  waveAppearanceRef.current = waveAppearance;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const siri = createSiriState();
    const renderer = new SiriRenderer(canvas);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    siriRef.current = siri;
    rendererRef.current = renderer;
    reducedMotionRef.current = reducedMotion;
    siri.select(phase === "transcribing" ? "thinking" : "listening");

    const renderStaticFrame = () => {
      for (let index = 0; index < 120; index += 1) {
        siri.tick(1 / 60, SILENT_BANDS);
      }
      renderer.render(siri, SILENT_BANDS, 0, glassMaterialRef.current, waveAppearanceRef.current);
    };

    let previous = performance.now();
    const render = (now: number) => {
      frameRef.current = 0;
      const dt = Math.min(0.1, Math.max(0, (now - previous) / 1_000));
      const scaledDt = dt * timeScaleRef.current;
      previous = now;
      const bands = siri.state === "listening" ? bandsForLevel(levelRef.current) : SILENT_BANDS;
      siri.tick(scaledDt, bands);
      renderer.render(siri, bands, scaledDt, glassMaterialRef.current, waveAppearanceRef.current);
      if (!renderer.error) frameRef.current = requestAnimationFrame(render);
    };

    const startAnimation = () => {
      if (frameRef.current !== 0 || renderer.error) return;
      previous = performance.now();
      frameRef.current = requestAnimationFrame(render);
    };

    const handleRendererRestored = () => {
      if (reducedMotion) {
        renderStaticFrame();
      } else {
        startAnimation();
      }
    };

    canvas.addEventListener("siri-render-restored", handleRendererRestored);
    if (reducedMotion) {
      renderStaticFrame();
    } else {
      startAnimation();
    }

    return () => {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      canvas.removeEventListener("siri-render-restored", handleRendererRestored);
      renderer.dispose();
      siriRef.current = null;
      rendererRef.current = null;
    };
    // Phase changes are synchronized below so the WebGL choreography is not remounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const siri = siriRef.current;
    const renderer = rendererRef.current;
    if (!siri || !renderer) return;

    const target = phase === "transcribing" ? "thinking" : "listening";
    if (siri.state !== target) siri.select(target);

    if (reducedMotionRef.current) {
      for (let index = 0; index < 120; index += 1) {
        siri.tick(1 / 60, SILENT_BANDS);
      }
      renderer.render(siri, SILENT_BANDS, 0, glassMaterialRef.current, waveAppearanceRef.current);
    }
  }, [phase]);

  useEffect(() => {
    const siri = siriRef.current;
    const renderer = rendererRef.current;
    if (!reducedMotionRef.current || !siri || !renderer) return;
    renderer.render(siri, SILENT_BANDS, 0, glassMaterial, waveAppearance);
  }, [glassMaterial, waveAppearance]);

  return (
    <div
      className="golos-dictation-capsule"
      role="status"
      aria-label={phase === "transcribing" ? "Распознаём речь" : "Идёт запись"}
    >
      <canvas
        ref={canvasRef}
        className="golos-capsule-canvas"
        data-visual-state={phase === "transcribing" ? "thinking" : "listening"}
        aria-hidden="true"
      />
    </div>
  );
}
