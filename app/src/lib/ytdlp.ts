// The yt-dlp logic lives in @marknotton/yoink-core, shared with every other app that uses Yoink's engine.
// This file only keeps the names the app already imports.
import type { Choice, Progress, VideoInfo } from "@marknotton/yoink-core"

export { buildChoices } from "@marknotton/yoink-core"
export type { Progress, VideoInfo }
export type DownloadChoice = Choice
