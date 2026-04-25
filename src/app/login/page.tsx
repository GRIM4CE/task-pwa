"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");

  useEffect(() => {
    // Redirect to setup if no user exists
    api.auth.status().then(({ data }) => {
      if (data?.needsSetup) router.replace("/setup");
      if (data?.isAuthenticated) router.replace("/todos");
    });
  }, [router]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const { data, error } = await api.auth.login({ username, totpCode });
    setLoading(false);

    if (error) {
      setError(error);
      setTotpCode("");
      return;
    }

    if (data?.success) {
      router.push("/todos");
    }
  }

  async function handleRecovery(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const { data, error } = await api.auth.recovery({ username, recoveryCode });
    setLoading(false);

    if (error) {
      setError(error);
      setRecoveryCode("");
      return;
    }

    if (data?.success) {
      if (data.remainingRecoveryCodes <= 2) {
        alert(`Warning: You only have ${data.remainingRecoveryCodes} recovery codes remaining. Consider setting up a new TOTP device.`);
      }
      router.push("/todos");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-text">Todo</h1>
          <p className="mt-2 text-sm text-text-muted">
            Enter your credentials to continue
          </p>
        </div>

        {!showRecovery ? (
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label htmlFor="username" className="block text-sm font-medium text-text-muted">
                Username
              </label>
              <input
                id="username"
                type="text"
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-border bg-white px-3 py-2 text-app placeholder-gray-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder="admin"
              />
            </div>

            <div>
              <label htmlFor="totp" className="block text-sm font-medium text-text-muted">
                Authenticator Code
              </label>
              <input
                id="totp"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                autoComplete="one-time-code"
                required
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                className="mt-1 block w-full rounded-lg border border-border bg-white px-3 py-2 text-center text-2xl tracking-[0.3em] text-app placeholder-gray-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder="000000"
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
              className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-text hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>

            <button
              type="button"
              onClick={() => setShowRecovery(true)}
              className="w-full text-sm text-text-muted hover:text-text"
            >
              Use a recovery code instead
            </button>
          </form>
        ) : (
          <form onSubmit={handleRecovery} className="space-y-4">
            <div>
              <label htmlFor="rec-username" className="block text-sm font-medium text-text-muted">
                Username
              </label>
              <input
                id="rec-username"
                type="text"
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-border bg-white px-3 py-2 text-app placeholder-gray-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder="admin"
              />
            </div>

            <div>
              <label htmlFor="recovery" className="block text-sm font-medium text-text-muted">
                Recovery Code
              </label>
              <input
                id="recovery"
                type="text"
                required
                maxLength={8}
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value.toLowerCase().slice(0, 8))}
                className="mt-1 block w-full rounded-lg border border-border bg-white px-3 py-2 text-center text-lg tracking-wider text-app placeholder-gray-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                placeholder="abcd1234"
              />
            </div>

            {error && (
              <div className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || recoveryCode.length !== 8}
              className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-text hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Verifying..." : "Use Recovery Code"}
            </button>

            <button
              type="button"
              onClick={() => setShowRecovery(false)}
              className="w-full text-sm text-text-muted hover:text-text"
            >
              Back to authenticator login
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
