import { useEffect, useState } from "react";

import { GolosCapsule, type GolosCapsulePhase } from "./GolosCapsule";
import {
  DEFAULT_SIRI_WAVE_APPEARANCE,
  type SiriWaveAppearance,
  type SiriWaveColor,
  type SiriWavePalette,
} from "./golos-siri/shaders";

type StoryStep = "hidden-before" | "listening" | "transcribing" | "hidden-after";
type DemoAudioProfile = "smooth" | "spikes";
type DemoRenderer = "webgl" | "css-fallback";

const DEMO_TIME_STRETCH = 1;
const DEMO_PLAYBACK_RATE = 1;
const LISTENING_START_MS = 900 * DEMO_TIME_STRETCH;
const TRANSCRIBING_START_MS = 3_400 * DEMO_TIME_STRETCH;
const HIDDEN_AFTER_MS = 6_400 * DEMO_TIME_STRETCH;
const DEMO_AUDIO_SAMPLE_MS = 50;
const DEMO_SPIKE_AUDIO_SAMPLE_MS = 20;
const DEMO_AUDIO_SMOOTHING = 1 - Math.pow(1 - 0.2, 1 / DEMO_TIME_STRETCH);

const WAVE_COUNT_MIN = 1;
const WAVE_COUNT_MAX = 8;

const WAVE_COLOR_INDICES = [0, 1, 2] as const;

function createDefaultWaveAppearance(): SiriWaveAppearance {
  return {
    baseColors: DEFAULT_SIRI_WAVE_APPEARANCE.baseColors.map(
      (color) => [...color] as SiriWaveColor
    ) as SiriWavePalette,
    highlightColors: DEFAULT_SIRI_WAVE_APPEARANCE.highlightColors.map(
      (color) => [...color] as SiriWaveColor
    ) as SiriWavePalette,
    waveCount: DEFAULT_SIRI_WAVE_APPEARANCE.waveCount,
    audioBrightnessResponse: DEFAULT_SIRI_WAVE_APPEARANCE.audioBrightnessResponse,
    audioBrightnessSmoothing: DEFAULT_SIRI_WAVE_APPEARANCE.audioBrightnessSmoothing,
  };
}

function waveColorToHex(color: SiriWaveColor) {
  return `#${color
    .map((channel) =>
      Math.round(Math.max(0, Math.min(1, channel)) * 255)
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
}

function hexToWaveColor(hex: string): SiriWaveColor | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function demoVoiceTarget(elapsedMs: number) {
  const seconds = elapsedMs / 1_000;
  const syllables = 0.48 + Math.sin(seconds * 7.8) * 0.25 + Math.sin(seconds * 13.2 + 1.1) * 0.14;
  const phrase = 0.8 + Math.sin(seconds * 2.2 - 0.4) * 0.16;
  return Math.max(0.16, Math.min(0.92, syllables * phrase + 0.18));
}

function demoSpikeTarget(elapsedMs: number) {
  const phaseMs = elapsedMs % 1_400;
  if (phaseMs < 100) return 0.04;
  if (phaseMs < 220) return 1;
  if (phaseMs < 280) return 0.08;
  if (phaseMs < 360) return 0.96;
  if (phaseMs < 620) return 0.06;
  if (phaseMs < 760) return 0.88;
  if (phaseMs < 820) return 0.03;
  if (phaseMs < 900) return 1;
  return 0.08;
}

const TIMELINE: Array<{
  id: StoryStep;
  index: string;
  title: string;
  detail: string;
}> = [
  { id: "hidden-before", index: "00", title: "Hidden", detail: "Ожидание хоткея" },
  {
    id: "listening",
    index: "01",
    title: "Listening",
    detail: "Идёт запись · волны реагируют на голос",
  },
  {
    id: "transcribing",
    index: "02",
    title: "Transcribing",
    detail: "Идёт распознавание · волны переходят в точки",
  },
  { id: "hidden-after", index: "03", title: "Hidden", detail: "Текст вставлен · окно скрыто" },
];

function OrbViewport({
  phase,
  audioLevel = 0,
  label,
  waveAppearance,
}: {
  phase?: GolosCapsulePhase;
  audioLevel?: number;
  label: string;
  waveAppearance?: SiriWaveAppearance;
}) {
  return (
    <div className="relative h-[176px] overflow-hidden rounded-[20px] border border-white/[0.08] bg-[#050707]">
      <div className="pointer-events-none absolute inset-0 opacity-35 [background-image:linear-gradient(rgba(255,255,255,.045)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.045)_1px,transparent_1px)] [background-size:24px_24px]" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[92px] w-[120px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#16e4c0]/[0.05] blur-2xl" />

      {phase ? (
        <GolosCapsule phase={phase} audioLevel={audioLevel} waveAppearance={waveAppearance} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex h-[64px] w-[90px] items-center justify-center rounded-full border border-dashed border-white/[0.16] font-mono text-[9px] uppercase tracking-[0.18em] text-white/25">
            no window
          </div>
        </div>
      )}

      <span className="absolute bottom-3 left-3 font-mono text-[9px] uppercase tracking-[0.18em] text-white/35">
        {label}
      </span>
    </div>
  );
}

function CssFallbackCapsule({ phase }: { phase: GolosCapsulePhase }) {
  return (
    <div
      className="golos-dictation-capsule"
      role="status"
      aria-label={
        phase === "transcribing"
          ? "Распознаём речь — упрощённая графика"
          : "Идёт запись — упрощённая графика"
      }
    >
      <canvas
        className="golos-capsule-canvas"
        data-fallback="true"
        data-visual-state={phase === "transcribing" ? "thinking" : "listening"}
        aria-hidden="true"
      />
    </div>
  );
}

function StoryFrame({
  number,
  state,
  description,
  phase,
  audioLevel,
  waveAppearance,
}: {
  number: string;
  state: string;
  description: string;
  phase?: GolosCapsulePhase;
  audioLevel?: number;
  waveAppearance?: SiriWaveAppearance;
}) {
  return (
    <article className="min-w-0">
      <OrbViewport
        phase={phase}
        audioLevel={audioLevel}
        label={`${number} / ${state}`}
        waveAppearance={waveAppearance}
      />
      <div className="mt-4 grid grid-cols-[36px_1fr] gap-3">
        <span className="font-mono text-[10px] tracking-[0.16em] text-[#6fffe1]">{number}</span>
        <div>
          <h3 className="font-[var(--font-family-extended)] text-[14px] uppercase tracking-[0.08em] text-white">
            {state}
          </h3>
          <p className="mt-1 max-w-[25ch] text-[12px] leading-[1.45] text-white/45">
            {description}
          </p>
        </div>
      </div>
    </article>
  );
}

export default function OrbStoryboard() {
  const [run, setRun] = useState(0);
  const [isAutoPlaying, setIsAutoPlaying] = useState(true);
  const [phase, setPhase] = useState<GolosCapsulePhase>("listening");
  const [audioLevel, setAudioLevel] = useState(0.08);
  const [audioProfile, setAudioProfile] = useState<DemoAudioProfile>("smooth");
  const [demoRenderer, setDemoRenderer] = useState<DemoRenderer>("webgl");
  const [activeStep, setActiveStep] = useState<StoryStep>("hidden-before");
  const [isWavePanelCollapsed, setIsWavePanelCollapsed] = useState(false);
  const [waveAppearance, setWaveAppearance] = useState<SiriWaveAppearance>(
    createDefaultWaveAppearance
  );

  useEffect(() => {
    if (!isAutoPlaying) return;

    setPhase("listening");
    setAudioLevel(0.08);
    setActiveStep("hidden-before");

    const timers = [
      window.setTimeout(() => {
        setActiveStep("listening");
      }, LISTENING_START_MS),
      window.setTimeout(() => {
        setPhase("transcribing");
        setActiveStep("transcribing");
      }, TRANSCRIBING_START_MS),
      window.setTimeout(() => {
        setActiveStep("hidden-after");
      }, HIDDEN_AFTER_MS),
    ];

    return () => timers.forEach(window.clearTimeout);
  }, [isAutoPlaying, run]);

  useEffect(() => {
    if (activeStep !== "listening") return;

    setAudioLevel(0.08);
    const startedAt = performance.now();
    const isSpikeProfile = audioProfile === "spikes";
    const sampleIntervalMs = isSpikeProfile ? DEMO_SPIKE_AUDIO_SAMPLE_MS : DEMO_AUDIO_SAMPLE_MS;
    const audioInterval = window.setInterval(() => {
      const elapsedMs = (performance.now() - startedAt) / DEMO_TIME_STRETCH;
      const targetLevel = isSpikeProfile ? demoSpikeTarget(elapsedMs) : demoVoiceTarget(elapsedMs);
      setAudioLevel(
        (currentLevel) => currentLevel + (targetLevel - currentLevel) * DEMO_AUDIO_SMOOTHING
      );
    }, sampleIntervalMs);

    return () => window.clearInterval(audioInterval);
  }, [activeStep, audioProfile]);

  const selectStep = (step: StoryStep) => {
    setIsAutoPlaying(false);
    setActiveStep(step);

    if (step === "listening") {
      setPhase("listening");
    } else if (step === "transcribing") {
      setPhase("transcribing");
    }
  };

  const selectAudioProfile = (profile: DemoAudioProfile) => {
    setAudioProfile(profile);
    selectStep("listening");
  };

  const setAudioBrightnessSmoothing = (isEnabled: boolean) => {
    setWaveAppearance((current) => ({
      ...current,
      audioBrightnessSmoothing: isEnabled,
    }));
    selectStep("listening");
  };

  const replay = () => {
    setIsAutoPlaying(true);
    setRun((value) => value + 1);
  };

  const setBaseWaveColor = (index: number, hex: string) => {
    const color = hexToWaveColor(hex);
    if (!color) return;
    setWaveAppearance((current) => {
      const baseColors = current.baseColors.map((item) => [...item] as SiriWaveColor);
      baseColors[index] = color;
      return { ...current, baseColors: baseColors as SiriWavePalette };
    });
  };

  const setWaveHighlightColor = (index: number, hex: string) => {
    const color = hexToWaveColor(hex);
    if (!color) return;
    setWaveAppearance((current) => {
      const highlightColors = current.highlightColors.map((item) => [...item] as SiriWaveColor);
      highlightColors[index] = color;
      return { ...current, highlightColors: highlightColors as SiriWavePalette };
    });
  };

  const setWaveCount = (value: number) => {
    if (!Number.isFinite(value)) return;
    const waveCount = Math.round(Math.max(WAVE_COUNT_MIN, Math.min(WAVE_COUNT_MAX, value)));
    setWaveAppearance((current) => ({ ...current, waveCount }));
  };

  const resetWaveAppearance = () => {
    setWaveAppearance(createDefaultWaveAppearance());
  };

  const activeItem = TIMELINE.find((item) => item.id === activeStep) ?? TIMELINE[0];
  const isCapsuleVisible = activeStep === "listening" || activeStep === "transcribing";

  return (
    <div className="min-h-screen bg-[#090b0b] text-white selection:bg-[#6fffe1] selection:text-[#07100e]">
      <div className="mx-auto max-w-[1240px] px-6 py-8 sm:px-10 sm:py-12">
        <header className="grid gap-8 border-b border-white/10 pb-8 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.26em] text-[#6fffe1]">
              Type / motion lab 01
            </p>
            <h1 className="mt-4 max-w-[800px] font-[var(--font-family-heading-serif-condensed)] text-[clamp(44px,7vw,92px)] font-normal leading-[0.82] tracking-[-0.035em]">
              Orb states
            </h1>
            <p className="mt-5 max-w-[58ch] text-[14px] leading-relaxed text-white/48">
              Упрощённая раскадровка рабочего цикла: от нажатия хоткея до окончания распознавания.
            </p>
          </div>

          <div className="font-mono text-[10px] uppercase leading-[1.8] tracking-[0.16em] text-white/32 lg:text-right">
            <div>WebGL 2</div>
            <div>Spring transition</div>
            <div>Playback 1×</div>
          </div>
        </header>

        <section className="mt-8 grid overflow-hidden rounded-[28px] border border-white/10 bg-[#0e1111] lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="relative min-h-[390px] overflow-hidden border-b border-white/10 lg:border-b-0 lg:border-r">
            <div className="absolute inset-0 opacity-45 [background:radial-gradient(circle_at_50%_55%,rgba(17,190,219,.14),transparent_36%),linear-gradient(135deg,rgba(23,190,147,.04),transparent_45%)]" />
            <div className="absolute left-5 top-5 z-10 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.16em] text-white/35">
              <span className="h-1.5 w-1.5 rounded-full bg-[#6fffe1] shadow-[0_0_12px_#6fffe1]" />
              {demoRenderer === "css-fallback"
                ? "CSS fallback · click to switch"
                : isAutoPlaying
                  ? "Live product flow · 1×"
                  : "Manual state · click to switch"}
            </div>
            <div className="absolute inset-0">
              {isCapsuleVisible && demoRenderer === "css-fallback" ? (
                <CssFallbackCapsule phase={phase} />
              ) : isCapsuleVisible ? (
                <GolosCapsule
                  key={run}
                  phase={phase}
                  audioLevel={audioLevel}
                  timeScale={DEMO_PLAYBACK_RATE}
                  waveAppearance={waveAppearance}
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="flex h-[64px] w-[90px] items-center justify-center rounded-full border border-dashed border-white/[0.12] font-mono text-[9px] uppercase tracking-[0.18em] text-white/20">
                    no window
                  </div>
                </div>
              )}
            </div>
          </div>

          <aside className="flex flex-col p-5 sm:p-7">
            <div className="mb-8 flex items-center justify-between">
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/30">
                  Current state
                </p>
                <p className="mt-1 font-[var(--font-family-extended)] text-[15px] uppercase tracking-[0.08em] text-white">
                  {activeItem.title}
                </p>
              </div>
              <button
                type="button"
                onClick={replay}
                className="rounded-full border border-[#6fffe1]/30 bg-[#6fffe1]/10 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.13em] text-[#8affea] transition hover:border-[#6fffe1]/60 hover:bg-[#6fffe1]/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6fffe1]"
              >
                ↻ Повторить
              </button>
            </div>

            <ol className="relative flex flex-1 flex-col justify-between before:absolute before:bottom-4 before:left-[15px] before:top-4 before:w-px before:bg-white/10">
              {TIMELINE.map((item) => {
                const isActive = item.id === activeStep;
                return (
                  <li key={item.id} className="relative">
                    {item.id === "transcribing" && (
                      <span className="absolute -top-3 left-[15px] z-20 -translate-x-1/2 bg-[#0e1111] px-1 font-mono text-[7px] uppercase tracking-[0.14em] text-[#6fffe1]/55">
                        morph
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label={`Показать состояние ${item.title}: ${item.detail}`}
                      aria-pressed={isActive}
                      onClick={() => selectStep(item.id)}
                      className="group relative grid w-full grid-cols-[32px_1fr] gap-3 rounded-xl py-2 text-left transition-colors hover:bg-white/[0.025] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6fffe1]"
                    >
                      <span
                        className={`relative z-10 flex h-8 w-8 items-center justify-center rounded-full border font-mono text-[9px] transition duration-300 ${
                          isActive
                            ? "border-[#6fffe1] bg-[#6fffe1] text-[#07100e] shadow-[0_0_20px_rgba(111,255,225,.25)]"
                            : "border-white/10 bg-[#0e1111] text-white/28 group-hover:border-white/20 group-hover:text-white/50"
                        }`}
                      >
                        {item.index}
                      </span>
                      <span className="pt-0.5">
                        <span
                          className={`block text-[12px] font-medium transition-colors ${
                            isActive ? "text-white" : "text-white/45 group-hover:text-white/65"
                          }`}
                        >
                          {item.title}
                        </span>
                        <span className="mt-0.5 block text-[10px] text-white/28">
                          {item.detail}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </aside>
        </section>

        <section
          aria-labelledby="wave-controls-title"
          className="fixed inset-x-3 bottom-3 z-50 max-h-[calc(100dvh-24px)] overflow-y-auto overscroll-contain rounded-[20px] bg-[#0e1111]/95 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_24px_80px_rgba(0,0,0,0.55)] backdrop-blur-xl sm:inset-x-auto sm:bottom-5 sm:right-5 sm:w-[480px] sm:max-w-[calc(100vw-40px)]"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[#6fffe1]">
                Live wave controls
              </p>
              <h2
                id="wave-controls-title"
                className="mt-1.5 text-[18px] font-medium tracking-[-0.02em] [text-wrap:balance]"
              >
                Цвета и количество волн
              </h2>
              {!isWavePanelCollapsed && (
                <p className="mt-1 max-w-[48ch] text-[10px] leading-relaxed text-white/42 [text-wrap:pretty]">
                  Три волны получают свои пары цветов, дополнительные повторяют палитру.
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!isWavePanelCollapsed && (
                <button
                  type="button"
                  onClick={resetWaveAppearance}
                  className="min-h-10 rounded-full bg-white/[0.06] px-3 font-mono text-[8px] uppercase tracking-[0.12em] text-white/55 shadow-[0_0_0_1px_rgba(255,255,255,0.1)] transition-transform duration-150 ease-out hover:bg-white/[0.09] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6fffe1]"
                >
                  Сбросить
                </button>
              )}
              <button
                type="button"
                aria-label={
                  isWavePanelCollapsed ? "Развернуть настройки волн" : "Свернуть настройки волн"
                }
                aria-expanded={!isWavePanelCollapsed}
                onClick={() => setIsWavePanelCollapsed((value) => !value)}
                className="min-h-10 rounded-full bg-white/[0.06] px-3 font-mono text-[8px] uppercase tracking-[0.12em] text-white/55 shadow-[0_0_0_1px_rgba(255,255,255,0.1)] transition-transform duration-150 ease-out hover:bg-white/[0.09] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6fffe1]"
              >
                {isWavePanelCollapsed ? "Развернуть" : "Свернуть"}
              </button>
            </div>
          </div>

          {!isWavePanelCollapsed && (
            <div className="mt-4">
              <div className="mb-2 rounded-[12px] bg-black/20 p-2.5 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-[8px] uppercase tracking-[0.1em] text-white/38">
                      Рендер превью
                    </p>
                    <p className="mt-1 font-mono text-[8px] text-white/28">
                      Fallback включается автоматически при ошибке WebGL
                    </p>
                  </div>
                  <div
                    role="group"
                    aria-label="Режим рендера превью"
                    className="grid shrink-0 grid-cols-2 gap-1 rounded-[12px] bg-white/[0.04] p-1 shadow-[0_0_0_1px_rgba(255,255,255,0.07)]"
                  >
                    {(
                      [
                        { id: "webgl", label: "WebGL" },
                        { id: "css-fallback", label: "CSS fallback" },
                      ] as const
                    ).map((renderer) => {
                      const isSelected = demoRenderer === renderer.id;
                      return (
                        <button
                          key={renderer.id}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => setDemoRenderer(renderer.id)}
                          className={`h-10 rounded-[8px] px-2.5 font-mono text-[8px] uppercase tracking-[0.08em] transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6fffe1] ${
                            isSelected
                              ? "bg-[#6fffe1]/12 text-[#8affea] shadow-[0_0_0_1px_rgba(111,255,225,0.3)]"
                              : "text-white/38 hover:bg-white/[0.05] hover:text-white/60"
                          }`}
                        >
                          {renderer.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="mb-4 rounded-[12px] bg-black/20 p-2.5 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-[8px] uppercase tracking-[0.1em] text-white/38">
                      Тестовый аудиосигнал
                    </p>
                    <p className="mt-1 truncate font-mono text-[8px] text-white/28 [font-variant-numeric:tabular-nums]">
                      уровень {audioLevel.toFixed(2)} · шаг{" "}
                      {audioProfile === "spikes" ? "20 мс" : "50 мс"}
                    </p>
                  </div>
                  <div
                    role="group"
                    aria-label="Профиль тестового аудиосигнала"
                    className="grid shrink-0 grid-cols-2 gap-1 rounded-[12px] bg-white/[0.04] p-1 shadow-[0_0_0_1px_rgba(255,255,255,0.07)]"
                  >
                    {(
                      [
                        { id: "smooth", label: "Плавный" },
                        { id: "spikes", label: "Резкие пики" },
                      ] as const
                    ).map((profile) => {
                      const isSelected = audioProfile === profile.id;
                      return (
                        <button
                          key={profile.id}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => selectAudioProfile(profile.id)}
                          className={`h-10 rounded-[8px] px-2.5 font-mono text-[8px] uppercase tracking-[0.08em] transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6fffe1] ${
                            isSelected
                              ? "bg-[#6fffe1]/12 text-[#8affea] shadow-[0_0_0_1px_rgba(111,255,225,0.3)]"
                              : "text-white/38 hover:bg-white/[0.05] hover:text-white/60"
                          }`}
                        >
                          {profile.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="mt-2 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-2">
                  <div className="min-w-0">
                    <p className="font-mono text-[8px] uppercase tracking-[0.1em] text-white/38">
                      Яркость от громкости
                    </p>
                    <p className="mt-1 font-mono text-[8px] text-white/28">
                      {waveAppearance.audioBrightnessSmoothing
                        ? "Сила 100% · атака/возврат 50 мс"
                        : "Сила 100% · без задержки"}
                    </p>
                  </div>
                  <div
                    role="group"
                    aria-label="Сглаживание реакции яркости на громкость"
                    className="grid shrink-0 grid-cols-2 gap-1 rounded-[12px] bg-white/[0.04] p-1 shadow-[0_0_0_1px_rgba(255,255,255,0.07)]"
                  >
                    {(
                      [
                        { label: "Сглажено", value: true },
                        { label: "Мгновенно", value: false },
                      ] as const
                    ).map((option) => {
                      const isSelected = waveAppearance.audioBrightnessSmoothing === option.value;
                      return (
                        <button
                          key={option.label}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => setAudioBrightnessSmoothing(option.value)}
                          className={`h-10 rounded-[8px] px-2.5 font-mono text-[8px] uppercase tracking-[0.08em] transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6fffe1] ${
                            isSelected
                              ? "bg-[#6fffe1]/12 text-[#8affea] shadow-[0_0_0_1px_rgba(111,255,225,0.3)]"
                              : "text-white/38 hover:bg-white/[0.05] hover:text-white/60"
                          }`}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[11px] font-medium text-white/75">Три пары цветов</p>
                <p className="font-mono text-[8px] uppercase tracking-[0.1em] text-white/25">
                  Цикл 1–3
                </p>
              </div>
              <div className="mt-2 overflow-hidden rounded-[12px] bg-black/20 px-2 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
                <div className="grid grid-cols-[32px_minmax(0,1fr)_minmax(0,1fr)] gap-2 px-1 py-2 font-mono text-[8px] uppercase tracking-[0.1em] text-white/30">
                  <span>Пара</span>
                  <span>Основной</span>
                  <span>Свечение</span>
                </div>
                <div className="divide-y divide-white/[0.06]">
                  {WAVE_COLOR_INDICES.map((index) => {
                    const baseColorHex = waveColorToHex(waveAppearance.baseColors[index]);
                    const highlightColorHex = waveColorToHex(waveAppearance.highlightColors[index]);
                    const baseControlId = `wave-control-base-${index}`;
                    const highlightControlId = `wave-control-highlight-${index}`;

                    return (
                      <div
                        key={index}
                        className="grid grid-cols-[32px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 px-1 py-1.5"
                      >
                        <span className="font-mono text-[9px] text-white/38 [font-variant-numeric:tabular-nums]">
                          {String(index + 1).padStart(2, "0")}
                        </span>

                        <div className="flex min-w-0 items-center gap-1.5">
                          <label
                            htmlFor={baseControlId}
                            aria-label={`Основной цвет пары ${index + 1}`}
                            className="relative block h-10 w-10 shrink-0 cursor-pointer rounded-[9px] shadow-[0_0_0_1px_rgba(255,255,255,0.14),0_4px_16px_rgba(0,0,0,0.24)]"
                            style={{ backgroundColor: baseColorHex }}
                          >
                            <input
                              id={baseControlId}
                              type="color"
                              value={baseColorHex}
                              onChange={(event) =>
                                setBaseWaveColor(index, event.currentTarget.value)
                              }
                              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                            />
                          </label>
                          <input
                            key={baseColorHex}
                            aria-label={`Основной цвет пары ${index + 1}, HEX`}
                            type="text"
                            defaultValue={baseColorHex.toUpperCase()}
                            maxLength={7}
                            spellCheck={false}
                            onBlur={(event) => {
                              if (hexToWaveColor(event.currentTarget.value)) {
                                setBaseWaveColor(index, event.currentTarget.value);
                              } else {
                                event.currentTarget.value = baseColorHex.toUpperCase();
                              }
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") event.currentTarget.blur();
                            }}
                            className="h-10 min-w-0 flex-1 rounded-[9px] bg-white/[0.055] px-1.5 text-center font-mono text-[9px] uppercase text-[#8affea] shadow-[0_0_0_1px_rgba(255,255,255,0.09)] [font-variant-numeric:tabular-nums] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#6fffe1]"
                          />
                        </div>

                        <div className="flex min-w-0 items-center gap-1.5">
                          <label
                            htmlFor={highlightControlId}
                            aria-label={`Цвет свечения пары ${index + 1}`}
                            className="relative block h-10 w-10 shrink-0 cursor-pointer rounded-[9px] shadow-[0_0_0_1px_rgba(255,255,255,0.14),0_4px_16px_rgba(0,0,0,0.24)]"
                            style={{ backgroundColor: highlightColorHex }}
                          >
                            <input
                              id={highlightControlId}
                              type="color"
                              value={highlightColorHex}
                              onChange={(event) =>
                                setWaveHighlightColor(index, event.currentTarget.value)
                              }
                              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                            />
                          </label>
                          <input
                            key={highlightColorHex}
                            aria-label={`Цвет свечения пары ${index + 1}, HEX`}
                            type="text"
                            defaultValue={highlightColorHex.toUpperCase()}
                            maxLength={7}
                            spellCheck={false}
                            onBlur={(event) => {
                              if (hexToWaveColor(event.currentTarget.value)) {
                                setWaveHighlightColor(index, event.currentTarget.value);
                              } else {
                                event.currentTarget.value = highlightColorHex.toUpperCase();
                              }
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") event.currentTarget.blur();
                            }}
                            className="h-10 min-w-0 flex-1 rounded-[9px] bg-white/[0.055] px-1.5 text-center font-mono text-[9px] uppercase text-[#8affea] shadow-[0_0_0_1px_rgba(255,255,255,0.09)] [font-variant-numeric:tabular-nums] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#6fffe1]"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="mt-2 rounded-[12px] bg-black/20 p-2.5 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
                <div className="flex items-center justify-between gap-3">
                  <label
                    htmlFor="wave-control-count"
                    className="font-mono text-[8px] uppercase tracking-[0.1em] text-white/38"
                  >
                    Количество волн
                  </label>
                  <input
                    aria-label="Количество волн, точное значение"
                    type="number"
                    min={WAVE_COUNT_MIN}
                    max={WAVE_COUNT_MAX}
                    step={1}
                    value={waveAppearance.waveCount}
                    onChange={(event) => setWaveCount(event.currentTarget.valueAsNumber)}
                    className="h-10 w-[56px] rounded-[9px] bg-white/[0.055] px-2 text-right font-mono text-[10px] text-[#8affea] shadow-[0_0_0_1px_rgba(255,255,255,0.09)] [font-variant-numeric:tabular-nums] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#6fffe1]"
                  />
                </div>
                <input
                  id="wave-control-count"
                  type="range"
                  min={WAVE_COUNT_MIN}
                  max={WAVE_COUNT_MAX}
                  step={1}
                  value={waveAppearance.waveCount}
                  onChange={(event) => setWaveCount(event.currentTarget.valueAsNumber)}
                  className="mt-1 h-10 w-full cursor-pointer accent-[#6fffe1]"
                />
              </div>
            </div>
          )}
        </section>

        <section className="mt-12">
          <div className="mb-5 flex items-end justify-between border-b border-white/10 pb-4">
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[#6fffe1]">
                Contact sheet
              </p>
              <h2 className="mt-2 text-[22px] font-medium tracking-[-0.02em]">
                Четыре продуктовых кадра
              </h2>
            </div>
            <p className="hidden font-mono text-[9px] uppercase tracking-[0.14em] text-white/25 sm:block">
              Actual renderer · not mockups
            </p>
          </div>

          <div className="grid gap-7 sm:grid-cols-2 xl:grid-cols-4">
            <StoryFrame
              number="00"
              state="Hidden"
              description="До записи BrowserWindow не показывает капсулу."
            />
            <StoryFrame
              number="01"
              state="Listening"
              description="Волны получают нормализованный уровень микрофона."
              phase="listening"
              audioLevel={0.78}
              waveAppearance={waveAppearance}
            />
            <StoryFrame
              number="02"
              state="Transcribing"
              description="После отпускания хоткея волны переходят в точки, пока распознаётся запись."
              phase="transcribing"
              waveAppearance={waveAppearance}
            />
            <StoryFrame
              number="03"
              state="Hidden"
              description="После вставки текста окно снова скрывается."
            />
          </div>
        </section>
      </div>
    </div>
  );
}
