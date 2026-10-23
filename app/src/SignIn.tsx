import { useEffect, useRef, useState } from "react"
import * as backend from "./lib/backend"
import { AlertIcon, CheckIcon } from "./icons"
import type { SignInSite } from "./lib/auth"

type Step = "intro" | "waiting" | "finishing" | "ok" | "failed"

// One screen for the whole sign-in: explain, open the site's login page, notice when it worked.
export function SignInDialog({ site, onSignedIn, onClose }: { site: SignInSite; onSignedIn: () => void; onClose: () => void }) {
  const [step, setStep] = useState<Step>("intro")
  const [error, setError] = useState<string | null>(null)
  const finishing = useRef(false)

  const finish = async () => {
    if (finishing.current) return
    finishing.current = true
    setStep("finishing")
    try {
      await backend.signinFinish(site.cookieUrls)
      setStep("ok")
      setTimeout(onSignedIn, 900)
    } catch (e) {
      finishing.current = false
      setError(e instanceof Error ? e.message : String(e))
      setStep("waiting")
    }
  }

  const start = async () => {
    setError(null)
    try {
      await backend.signinOpen(site.loginUrl, `Sign in to ${site.label}`)
      setStep("waiting")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStep("failed")
    }
  }

  // While the sign-in window is open: notice a finished login, a pressed Done, or a closed window
  useEffect(() => {
    if (step !== "waiting") return
    let seenSignedIn = 0
    const timer = setInterval(async () => {
      if (finishing.current) return
      try {
        const status = await backend.signinStatus(site.cookieUrls, site.markers)
        if (!status.open) {
          setStep("intro")
          setError("The sign-in window was closed before you finished.")
          return
        }
        if (status.done) void finish()
        // logged in: give the site a couple of seconds to set the rest of its cookies first
        else if (status.signedIn && ++seenSignedIn >= 2) void finish()
      } catch {
        // a missed poll is fine
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [step])

  const close = () => {
    if (step === "waiting" || step === "finishing") void backend.signinCancel()
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <section className="card modal" role="dialog" aria-label={`Sign in to ${site.label}`} onClick={(e) => e.stopPropagation()}>
        <header className="card-header">
          <h2 className="card-title">Sign in to {site.label}</h2>
        </header>
        <div className="card-body">
          {step === "intro" && (
            <>
              <p>{site.label} only shares this video with signed-in users, so Yoink needs you to log in once.</p>
              <p className="meta">
                A {site.label} sign-in page will open. Log in as you normally would. Yoink never sees your password: it keeps only the
                session, on this device, and uses it for {site.label} alone. You can sign out any time from About.
              </p>
              {site.note && <p className="meta">{site.note}</p>}
              {error && <p className="note note--error"><AlertIcon /> {error}</p>}
              <div className="modal__actions">
                <button className="btn btn--ghost" onClick={close}>Not now</button>
                <button className="btn btn--primary" onClick={() => void start()}>Open {site.label} sign-in</button>
              </div>
            </>
          )}

          {step === "waiting" && (
            <>
              <p className="note"><span className="spinner" /> Waiting for you to sign in…</p>
              <p className="meta">
                {site.markers.length > 0
                  ? "Log in in the window that just opened. This closes by itself once you're signed in."
                  : "Log in in the window that just opened, then press Done here."}
              </p>
              {error && <p className="note note--error"><AlertIcon /> {error}</p>}
              <div className="modal__actions">
                <button className="btn btn--ghost" onClick={close}>Cancel</button>
                {!backend.isAndroid && <button className="btn btn--primary" onClick={() => void finish()}>I’ve signed in — Done</button>}
              </div>
            </>
          )}

          {step === "finishing" && <p className="note"><span className="spinner" /> Saving your sign-in…</p>}

          {step === "ok" && <p className="callout callout--success"><CheckIcon /><span>Signed in to {site.label}. Trying again…</span></p>}

          {step === "failed" && (
            <>
              <p className="note note--error"><AlertIcon /> {error}</p>
              <div className="modal__actions">
                <button className="btn btn--ghost" onClick={close}>Close</button>
                <button className="btn btn--primary" onClick={() => setStep("intro")}>Try again</button>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
