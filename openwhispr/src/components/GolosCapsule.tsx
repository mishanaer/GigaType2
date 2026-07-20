import { useEffect, useRef } from "react";
import { SiriRenderer } from "./golos-siri/renderer";
import { createSiriState, type SiriBands } from "./golos-siri/state";

export type GolosCapsulePhase = "listening" | "transcribing";

interface GolosCapsuleProps {
  phase: GolosCapsulePhase;
  audioLevel?: number;
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
export function GolosCapsule({ phase, audioLevel = 0 }: GolosCapsuleProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const siriRef = useRef<ReturnType<typeof createSiriState> | null>(null);
  const rendererRef = useRef<SiriRenderer | null>(null);
  const frameRef = useRef(0);
  const levelRef = useRef(audioLevel);
  const reducedMotionRef = useRef(false);

  levelRef.current = audioLevel;

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

    if (reducedMotion) {
      for (let index = 0; index < 120; index += 1) {
        siri.tick(1 / 60, SILENT_BANDS);
      }
      renderer.render(siri, SILENT_BANDS, 0);
      return () => {
        renderer.dispose();
        siriRef.current = null;
        rendererRef.current = null;
      };
    }

    let previous = performance.now();
    const render = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - previous) / 1_000));
      previous = now;
      const bands = siri.state === "listening" ? bandsForLevel(levelRef.current) : SILENT_BANDS;
      siri.tick(dt, bands);
      renderer.render(siri, bands, dt);
      frameRef.current = requestAnimationFrame(render);
    };

    frameRef.current = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frameRef.current);
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
      renderer.render(siri, SILENT_BANDS, 0);
    }
  }, [phase]);

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
