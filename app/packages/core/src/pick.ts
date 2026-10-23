import type { Choice, Quality } from "./types.js"

// ── Choosing the format for a batch ──────────────────────────────
// buildChoices lists video rows tallest first, then the audio row, so the best
// video is simply the first video row
export function pickChoice(choices: Choice[], quality: Quality): Choice | undefined {
  if (quality === "audio") return choices.find((c) => c.kind === "audio") ?? choices[0]
  return choices.find((c) => c.kind === "video") ?? choices[0]
}

