import type { PushPullResult } from "../pushPull";

export type RhythmGaugeMotion = {
  from: number;
  to: number;
  trailLeft: number;
  trailWidth: number;
  scoreFrom: number;
  scoreTo: number;
  gain: number;
};

export function rhythmMarkerPercent(position: number): number {
  const clamped = Math.max(-100, Math.min(100, position));
  return (clamped + 100) / 2;
}

export function rhythmGaugeMotion(
  feedback: PushPullResult | undefined,
): RhythmGaugeMotion | undefined {
  if (!feedback || feedback.previousPosition === feedback.position) return undefined;
  const from = rhythmMarkerPercent(feedback.previousPosition);
  const to = rhythmMarkerPercent(feedback.position);
  return {
    from,
    to,
    trailLeft: Math.min(from, to),
    trailWidth: Math.abs(to - from),
    scoreFrom: feedback.previousAffection,
    scoreTo: feedback.affection,
    gain: feedback.gain,
  };
}
