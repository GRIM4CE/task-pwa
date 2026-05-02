"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import StatsView from "./_components/StatsView";
import CompletedView from "./_components/CompletedView";

type TabKey = "stats" | "completed";

function StatsTabs() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab: TabKey =
    searchParams.get("tab") === "completed" ? "completed" : "stats";

  function selectTab(tab: TabKey) {
    const next = tab === "stats" ? "/stats" : "/stats?tab=completed";
    router.replace(next, { scroll: false });
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div
        role="tablist"
        aria-label="Stats sections"
        className="mb-6 flex gap-1 rounded-lg border border-border-on-surface bg-surface p-1"
      >
        {(["stats", "completed"] as const).map((tab) => {
          const isActive = activeTab === tab;
          return (
            <button
              key={tab}
              role="tab"
              aria-selected={isActive}
              onClick={() => selectTab(tab)}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-surface ${
                isActive
                  ? "bg-primary font-semibold text-white shadow-md"
                  : "font-medium text-on-surface/60 hover:bg-surface-hover hover:text-on-surface"
              }`}
            >
              {tab === "stats" ? "Stats" : "Completed"}
            </button>
          );
        })}
      </div>

      {activeTab === "stats" ? <StatsView /> : <CompletedView />}
    </div>
  );
}

export default function StatsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      }
    >
      <StatsTabs />
    </Suspense>
  );
}
