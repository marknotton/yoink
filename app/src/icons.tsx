import type { ReactNode } from "react"

// ── 16×16 stroke icons ───────────────────────────────────────────
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

export const DownloadIcon = () => (
  <Icon><path d="M8 2.5v7.5M4.8 7.2 8 10.4l3.2-3.2M3 13h10" /></Icon>
)
export const FolderIcon = () => (
  <Icon><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.4l1.4 1.5h5.2A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" /></Icon>
)
export const PasteIcon = () => (
  <Icon><rect x="3.5" y="3" width="9" height="10.5" rx="1.5" /><path d="M6 3V2.5h4V3M6 7h4M6 10h2.5" /></Icon>
)
export const VideoIcon = () => (
  <Icon><rect x="2" y="3.5" width="12" height="9" rx="1.5" /><path d="m6.8 6 3 2-3 2z" /></Icon>
)
export const MusicIcon = () => (
  <Icon><path d="M6 11.5V3.5l6-1.2v8M6 11.5a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0zm6-1.2a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0z" /></Icon>
)
export const CheckIcon = () => (
  <Icon><path d="m3.5 8.5 3 3 6-7" /></Icon>
)
export const AlertIcon = () => (
  <Icon><path d="M8 2.5 14 13H2zM8 6.5v3M8 11.2v.1" /></Icon>
)
export const ClockIcon = () => (
  <Icon><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.2" /></Icon>
)
export const ExternalIcon = () => (
  <Icon><path d="M6.5 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9.5M9 2.5h4.5V7M13.5 2.5l-6 6" /></Icon>
)
export const UpdateAvailableIcon = () => (
  <Icon><circle cx="8" cy="8" r="5.5" /><path d="M8 11V5.5M5.5 8 8 5.5 10.5 8" /></Icon>
)
