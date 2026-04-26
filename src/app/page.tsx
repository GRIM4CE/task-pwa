"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isGuestMode } from "@/lib/guest-mode";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    if (isGuestMode()) {
      router.replace("/todos");
      return;
    }

    async function checkAuth() {
      try {
        const res = await fetch("/api/auth/status");
        const data = await res.json();

        if (data.needsSetup) {
          router.replace("/setup");
        } else if (data.isAuthenticated) {
          router.replace("/todos");
        } else {
          router.replace("/login");
        }
      } catch {
        router.replace("/login");
      }
    }

    checkAuth();
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
    </div>
  );
}
