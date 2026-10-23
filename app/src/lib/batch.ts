// Link finding, de-duplication, format picking and the work queue live in @marknotton/yoink-core.
import type { Quality } from "@marknotton/yoink-core"

export { extractUrls, MAX_BATCH, normaliseUrl, pickChoice, runPool } from "@marknotton/yoink-core"
export type { ExtractedLinks } from "@marknotton/yoink-core"
export type BatchQuality = Quality
