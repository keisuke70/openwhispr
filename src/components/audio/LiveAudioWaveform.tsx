import { useEffect, useState } from "react";
import { cn } from "../lib/utils";

interface LiveAudioWaveformProps {
  audioLevel: number;
  bars?: number;
  className?: string;
  barClassName?: string;
}

const PROFILE_POINTS = [0.2, 0.34, 0.52, 0.76, 1, 0.76, 0.52, 0.34, 0.2];

function getProfiles(bars: number) {
  if (bars <= 1) return [1];

  const maxIndex = PROFILE_POINTS.length - 1;
  return Array.from({ length: bars }, (_, index) => {
    const position = (index / (bars - 1)) * maxIndex;
    const lower = Math.floor(position);
    const upper = Math.min(maxIndex, Math.ceil(position));
    const mix = position - lower;
    const start = PROFILE_POINTS[lower];
    const end = PROFILE_POINTS[upper];
    return start + (end - start) * mix;
  });
}

export default function LiveAudioWaveform({
  audioLevel,
  bars = 5,
  className,
  barClassName,
}: LiveAudioWaveformProps) {
  const [displayLevel, setDisplayLevel] = useState(0);
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    setDisplayLevel((current) => {
      const smoothing = audioLevel > current ? 0.72 : 0.24;
      return current + (audioLevel - current) * smoothing;
    });
  }, [audioLevel]);

  useEffect(() => {
    let frameId = 0;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const delta = Math.min(48, now - lastTime);
      lastTime = now;
      setPhase((current) => current + delta * 0.009);
      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  const activeLevel = Math.max(0, Math.min(1, Math.pow(displayLevel, 0.78)));
  const profiles = getProfiles(bars);

  return (
    <div className={cn("flex items-end gap-0.5", className)}>
      {profiles.map((profile, index) => {
        const motion = ((Math.sin(phase + index * 0.82) + 1) / 2) * activeLevel;
        const height = 18 + activeLevel * profile * 62 + motion * 14;
        const opacity = 0.24 + activeLevel * (0.34 + profile * 0.28) + motion * 0.08;

        return (
          <div
            key={index}
            className={cn("min-w-0 flex-1 rounded-full", barClassName)}
            style={{
              height: `${Math.min(100, height)}%`,
              opacity: Math.min(1, opacity),
              transition: "height 80ms ease-out, opacity 80ms ease-out",
            }}
          />
        );
      })}
    </div>
  );
}
