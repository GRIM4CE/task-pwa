"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";

type Step = "intro" | "scan" | "verify" | "recovery";

export default function SecurityPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("intro");
  const [qrCodeUrl, setQrCodeUrl] = useState("");
  const [manualKey, setManualKey] = useState("");
  const [encryptedSecret, setEncryptedSecret] = useState("");
  const [encryptionIv, setEncryptionIv] = useState("");
  const [showManualKey, setShowManualKey] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleBegin() {
    setLoading(true);
    setError("");
    const { data, error } = await api.auth.resetAuthenticatorBegin();
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
      setStep("scan");
    }
  }

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const { data, error } = await api.auth.resetAuthenticatorConfirm({
      totpCode,
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
    navigator.clipboard.writeText(recoveryCodes.join("\n"));
  }

  function handleDone() {
    router.push("/settings");
  }

  return (
    <div className="mx-auto max-w-md px-4 py-6">
      <div className="mb-6">
        <Link href="/settings" className="text-sm text-text-muted hover:text-text">
          ← Back to settings
        </Link>
        <h2 className="mt-2 text-xl font-semibold text-text">Reset authenticator</h2>
        <p className="text-sm text-text-muted">
          {step === "intro" && "Replace your authenticator with a fresh secret. Only your account is affected."}
          {step === "scan" && "Scan this QR with your authenticator app, then continue."}
          {step === "verify" && "Enter a code from the new authenticator entry to confirm the swap."}
          {step === "recovery" && "Save these recovery codes — your old ones no longer work."}
        </p>
      </div>

      {step === "intro" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border-on-surface bg-surface p-4 text-sm text-on-surface/70">
            <p className="font-medium text-on-surface">What this does:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Generates a fresh TOTP secret for your account.</li>
              <li>Replaces your existing authenticator entry once you verify it.</li>
              <li>Issues 8 new recovery codes and invalidates the old ones.</li>
              <li>Other accounts on this app are not affected.</li>
            </ul>
          </div>

          {error && (
            <div className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </div>
          )}

          <button
            onClick={handleBegin}
            disabled={loading}
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {loading ? "Generating..." : "Generate new QR"}
          </button>
        </div>
      )}

      {step === "scan" && (
        <div className="space-y-4">
          <div className="flex justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qrCodeUrl}
              alt="New TOTP QR Code"
              width={256}
              height={256}
              className="rounded-lg"
            />
          </div>

          <button
            type="button"
            onClick={() => setShowManualKey(!showManualKey)}
            className="w-full text-sm text-text-muted hover:text-text"
          >
            {showManualKey ? "Hide" : "Show"} manual entry key
          </button>

          {showManualKey && (
            <div className="rounded-lg border border-border-on-surface bg-surface p-3 text-center">
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
        <form onSubmit={handleConfirm} className="space-y-4">
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
              className="mt-2 block w-full rounded-lg border border-border bg-input px-3 py-3 text-center text-2xl tracking-[0.3em] text-input-text placeholder-input-placeholder focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
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
            disabled={loading || totpCode.length !== 6}
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Confirming..." : "Confirm and replace"}
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
          <div className="rounded-lg border border-border-on-surface bg-surface p-4">
            <p className="mb-3 text-sm font-medium text-danger">
              Save these recovery codes securely. Each can only be used once.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {recoveryCodes.map((code, i) => (
                <div
                  key={i}
                  className="rounded bg-on-surface px-3 py-2 text-center font-mono text-sm text-input-text"
                >
                  {code}
                </div>
              ))}
            </div>
          </div>

          <button
            onClick={handleCopyRecoveryCodes}
            className="w-full rounded-lg border border-border-on-surface bg-surface px-4 py-2 text-sm text-on-surface/70 hover:bg-surface-hover"
          >
            Copy all codes
          </button>

          <label className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={savedConfirmed}
              onChange={(e) => setSavedConfirmed(e.target.checked)}
              className="h-4 w-4 rounded border-border bg-surface text-primary focus:ring-focus"
            />
            <span className="text-sm text-text-muted">
              I have saved my new recovery codes
            </span>
          </label>

          <button
            onClick={handleDone}
            disabled={!savedConfirmed}
            className="w-full rounded-lg bg-success px-4 py-2.5 text-sm font-medium text-white hover:bg-success/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}
