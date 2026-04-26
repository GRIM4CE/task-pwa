"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";

type SetupStep = "init" | "scan" | "verify" | "recovery" | "done";

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState<SetupStep>("init");
  const [qrCodeUrl, setQrCodeUrl] = useState("");
  const [manualKey, setManualKey] = useState("");
  const [encryptedSecret, setEncryptedSecret] = useState("");
  const [encryptionIv, setEncryptionIv] = useState("");
  const [usernames, setUsernames] = useState<string[]>([]);
  const [selectedUsername, setSelectedUsername] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showManualKey, setShowManualKey] = useState(false);
  const [savedConfirmed, setSavedConfirmed] = useState(false);

  useEffect(() => {
    // If already set up, redirect
    api.auth.status().then(({ data }) => {
      if (data && !data.needsSetup) {
        router.replace(data.isAuthenticated ? "/todos" : "/login");
      }
    });
  }, [router]);

  async function handleStartSetup() {
    setLoading(true);
    setError("");

    const { data, error } = await api.auth.setup();
    setLoading(false);

    if (error) {
      setError(error);
      return;
    }

    if (data) {
      setQrCodeUrl(data.qrCodeUrl);
      setManualKey(data.manualEntryKey);
      setEncryptedSecret(data.encryptedSecret);
      setEncryptionIv(data.encryptionIv);
      setUsernames(data.usernames);
      setSelectedUsername(data.usernames[0] ?? "");
      setStep("scan");
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const { data, error } = await api.auth.verifySetup({
      totpCode,
      selectedUsername,
      encryptedSecret,
      encryptionIv,
    });
    setLoading(false);

    if (error) {
      setError(error);
      setTotpCode("");
      return;
    }

    if (data?.success) {
      setRecoveryCodes(data.recoveryCodes);
      setStep("recovery");
    }
  }

  function handleCopyRecoveryCodes() {
    const text = recoveryCodes.join("\n");
    navigator.clipboard.writeText(text);
  }

  function handleComplete() {
    router.push("/todos");
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-text">Welcome to Todo</h1>
          <p className="mt-2 text-sm text-text-muted">
            {step === "init" && "Let's set up your account security."}
            {step === "scan" && "Scan this QR code with your authenticator app."}
            {step === "verify" && "Select who you are and verify the code."}
            {step === "recovery" && "Save your recovery codes in a safe place."}
          </p>
        </div>

        {step === "init" && (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-surface p-4 text-sm text-on-surface/60">
              <p className="font-medium text-on-surface">You&apos;ll need an authenticator app:</p>
              <ul className="mt-2 list-disc pl-5 space-y-1">
                <li>Google Authenticator</li>
                <li>Authy</li>
                <li>1Password</li>
                <li>Any TOTP-compatible app</li>
              </ul>
            </div>

            {error && (
              <div className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </div>
            )}

            <button
              onClick={handleStartSetup}
              disabled={loading}
              className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
            >
              {loading ? "Setting up..." : "Begin Setup"}
            </button>
          </div>
        )}

        {step === "scan" && (
          <div className="space-y-4">
            <div className="flex justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrCodeUrl}
                alt="TOTP QR Code"
                width={256}
                height={256}
                className="rounded-lg"
              />
            </div>

            {usernames.length > 1 && (
              <div className="rounded-lg border border-border bg-surface p-3 text-center text-sm text-on-surface/60">
                This code will be shared by: <span className="text-on-surface font-medium">{usernames.join(", ")}</span>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowManualKey(!showManualKey)}
              className="w-full text-sm text-text-muted hover:text-text"
            >
              {showManualKey ? "Hide" : "Show"} manual entry key
            </button>

            {showManualKey && (
              <div className="rounded-lg border border-border bg-surface p-3 text-center">
                <code className="break-all text-sm text-primary">{manualKey}</code>
              </div>
            )}

            <button
              onClick={() => setStep("verify")}
              className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-hover"
            >
              I&apos;ve scanned the code
            </button>
          </div>
        )}

        {step === "verify" && (
          <form onSubmit={handleVerify} className="space-y-4">
            {usernames.length > 1 && (
              <div>
                <label className="block text-sm font-medium text-text-muted mb-2">
                  Who are you?
                </label>
                <div className="flex gap-2">
                  {usernames.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setSelectedUsername(name)}
                      className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                        selectedUsername === name
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-surface text-on-surface/60 hover:bg-surface-hover"
                      }`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label htmlFor="verify-code" className="block text-sm font-medium text-text-muted">
                Enter the 6-digit code from your authenticator app
              </label>
              <input
                id="verify-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                autoComplete="one-time-code"
                required
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                className="mt-2 block w-full rounded-lg border border-border bg-input px-3 py-3 text-center text-2xl tracking-[0.3em] text-text placeholder-gray-400 focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
                placeholder="000000"
                autoFocus
              />
            </div>

            {error && (
              <div className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || totpCode.length !== 6 || !selectedUsername}
              className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Verifying..." : "Verify Code"}
            </button>

            <button
              type="button"
              onClick={() => setStep("scan")}
              className="w-full text-sm text-text-muted hover:text-text"
            >
              Back to QR code
            </button>
          </form>
        )}

        {step === "recovery" && (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-surface p-4">
              <p className="text-sm font-medium text-danger mb-3">
                Save these recovery codes securely. Each can only be used once.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {recoveryCodes.map((code, i) => (
                  <div
                    key={i}
                    className="rounded bg-on-surface px-3 py-2 text-center font-mono text-sm text-text"
                  >
                    {code}
                  </div>
                ))}
              </div>
            </div>

            <button
              onClick={handleCopyRecoveryCodes}
              className="w-full rounded-lg border border-border bg-surface px-4 py-2 text-sm text-on-surface/60 hover:bg-surface-hover"
            >
              Copy all codes
            </button>

            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={savedConfirmed}
                onChange={(e) => setSavedConfirmed(e.target.checked)}
                className="h-4 w-4 rounded border-border bg-surface text-primary focus:ring-focus"
              />
              <span className="text-sm text-text-muted">
                I have saved my recovery codes in a secure location
              </span>
            </label>

            <button
              onClick={handleComplete}
              disabled={!savedConfirmed}
              className="w-full rounded-lg bg-success px-4 py-2.5 text-sm font-medium text-white hover:bg-success/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Complete Setup
            </button>
          </div>
        )}

        {/* Step indicators */}
        <div className="flex justify-center gap-2">
          {["init", "scan", "verify", "recovery"].map((s) => (
            <div
              key={s}
              className={`h-2 w-2 rounded-full ${
                s === step ? "bg-primary" : "bg-border"
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
