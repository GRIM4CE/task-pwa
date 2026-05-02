"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StatsDTO } from "@/lib/api-client";
import {
  computeStats,
  percent,
  type AtRiskTodo,
  type DailyStat,
  type WeeklyStat,
} from "@/lib/analytics";
import { subscribeStatsMayHaveChanged } from "@/lib/stats-events";
import { useTodoRepository } from "@/lib/todos/use-todo-repository";

const WEEKDAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

export default function StatsView() {
  const repo = useTodoRepository();
  const [data, setData] = useState<StatsDTO | null>(null);
  const [loading, setLoading] = useState(true);
  // Monotonic id so overlapping refreshes (rapid toggles, visibility +
  // event subscriber firing back-to-back) can't reorder a stale response
  // over a fresh one. Only the most recently issued fetch's data is
  // returned; older in-flight ones resolve to null and the call sites
  // skip them.
  const refreshIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const myId = ++refreshIdRef.current;
    const { data } = await repo.stats();
    if (myId !== refreshIdRef.current) return null;
    return data;
  }, [repo]);

  useEffect(() => {
    let cancelled = false;
    refresh().then((data) => {
      if (cancelled) return;
      if (data) setData(data);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Refetch when the app comes back into focus so a toggle made on the
  // todos page (or via PWA app-switch) is reflected here without a manual
  // reload. Mirrors the same handler on /todos.
  useEffect(() => {
    let cancelled = false;
    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      refresh().then((data) => {
        if (cancelled) return;
        // Keep the previous render on a transient failure rather than
        // blanking the page; a network blip during a refresh shouldn't
        // collapse the analytics into the empty state.
        if (data) setData(data);
      });
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refresh]);

  // Refetch when the todos page signals a recurring toggle has committed.
  // The mount-time fetch above can race with an in-flight PATCH from the
  // previous route — visibility doesn't change during intra-app nav, so this
  // is the only refetch the user sees in that flow. Same null-data guard as
  // the visibility handler: don't blank the page on a transient blip.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribeStatsMayHaveChanged(() => {
      refresh().then((data) => {
        if (cancelled) return;
        if (data) setData(data);
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [refresh]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  const stats = data ? computeStats(data.todos) : null;
  const hasAnyRecurring =
    !!stats && (stats.daily.length > 0 || stats.weekly.length > 0);

  return (
    <>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-text">Repeat task stats</h2>
        <p className="text-sm text-text-muted">
          How often you&apos;re hitting your daily and weekly repeats.
        </p>
      </div>

      {!hasAnyRecurring ? (
        <div className="py-12 text-center">
          <p className="text-text-muted">
            No daily or weekly repeats yet. Set a repeat on a todo to start
            tracking.
          </p>
        </div>
      ) : (
        <>
          {stats && stats.global.atRiskToday.length > 0 && (
            <AtRiskBanner items={stats.global.atRiskToday} />
          )}
          {stats && <GlobalCard stats={stats.global} />}
          {stats && stats.daily.length > 0 && (
            <Section title="Daily" hint="This week (Mon–Sun)">
              <div className="space-y-2">
                {stats.daily.map((d) => (
                  <DailyRow key={d.id} stat={d} />
                ))}
              </div>
              <WeekdayConsistency rates={stats.global.weekdayConsistency} />
            </Section>
          )}
          {stats && stats.weekly.length > 0 && (
            <Section title="Weekly" hint="This calendar month">
              <div className="space-y-2">
                {stats.weekly.map((w) => (
                  <WeeklyRow key={w.id} stat={w} />
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-text-muted">{title}</h3>
        {hint && <span className="text-xs text-text-muted/70">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function GlobalCard({
  stats,
}: {
  stats: ReturnType<typeof computeStats>["global"];
}) {
  const weekPct = percent(stats.weekCompletedDays, stats.weekTotalDays);
  const monthPct = percent(stats.monthCompletedWeeks, stats.monthTotalWeeks);
  const prevWeekPct = percent(
    stats.prevWeekCompletedDays,
    stats.prevWeekTotalDays
  );
  const prevMonthPct = percent(
    stats.prevMonthCompletedWeeks,
    stats.prevMonthTotalWeeks
  );
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Tile
        label="Daily this week"
        value={stats.dailyCount === 0 ? "—" : `${weekPct}%`}
        sub={
          stats.dailyCount === 0
            ? "No daily repeats"
            : `${stats.weekCompletedDays} / ${stats.weekTotalDays} day-completions`
        }
        delta={
          stats.dailyCount === 0 || stats.prevWeekCompletedDays === 0
            ? null
            : { current: weekPct, previous: prevWeekPct, label: "vs last week" }
        }
      />
      <Tile
        label="Weekly this month"
        value={stats.weeklyCount === 0 ? "—" : `${monthPct}%`}
        sub={
          stats.weeklyCount === 0
            ? "No weekly repeats"
            : `${stats.monthCompletedWeeks} / ${stats.monthTotalWeeks} week-completions`
        }
        delta={
          stats.weeklyCount === 0 || stats.prevMonthCompletedWeeks === 0
            ? null
            : {
                current: monthPct,
                previous: prevMonthPct,
                label: "vs last month",
              }
        }
      />
    </div>
  );
}

function AtRiskBanner({ items }: { items: AtRiskTodo[] }) {
  return (
    <div className="mb-3 rounded-lg border border-focus/40 bg-focus/10 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-sm font-medium text-on-surface">
          Streaks at risk today
        </div>
        <div className="text-xs text-on-surface/60">
          {items.length} {items.length === 1 ? "todo" : "todos"}
        </div>
      </div>
      <ul className="mt-1 space-y-0.5 text-sm text-on-surface/80">
        {items.map((item) => (
          <li key={item.id} className="flex items-baseline justify-between gap-2">
            <span className="truncate">{item.title}</span>
            <span className="shrink-0 text-xs text-on-surface/60">
              {item.currentStreak}-day streak
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const WEEKDAY_FULL_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function WeekdayConsistency({ rates }: { rates: number[] }) {
  const total = rates.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const max = Math.max(...rates);
  const min = Math.min(...rates.filter((r) => r > 0));
  return (
    <div className="mt-3 rounded-lg border border-border-on-surface bg-surface px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-xs uppercase tracking-wide text-on-surface/60">
          Weekday consistency
        </div>
        <div className="text-[10px] text-on-surface/50">Last 30 days</div>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {rates.map((rate, i) => {
          const isBest = rate === max && rate > 0;
          const isWorst = rate === min && rate < max;
          const tone = isBest
            ? "bg-success/80 text-white"
            : isWorst
              ? "bg-focus/30 text-on-surface"
              : "bg-surface-hover text-on-surface/70";
          return (
            <div
              key={i}
              className={`flex flex-col items-center rounded px-1 py-1.5 text-[10px] ${tone}`}
              title={`${WEEKDAY_FULL_LABELS[i]}: ${Math.round(rate * 100)}% of daily todos completed`}
            >
              <span className="font-medium">{WEEKDAY_FULL_LABELS[i][0]}</span>
              <span className="text-[10px] opacity-90">
                {Math.round(rate * 100)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  delta,
}: {
  label: string;
  value: string;
  sub: string;
  delta?: { current: number; previous: number; label: string } | null;
}) {
  const diff = delta ? delta.current - delta.previous : null;
  return (
    <div className="rounded-lg border border-border-on-surface bg-surface px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-on-surface/60">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-semibold text-on-surface">{value}</span>
        {diff !== null && (
          <span
            className={`text-xs font-medium ${
              diff > 0
                ? "text-success"
                : diff < 0
                  ? "text-danger"
                  : "text-on-surface/60"
            }`}
          >
            {diff > 0 ? "+" : ""}
            {diff}pp {delta!.label}
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-on-surface/60">{sub}</div>
    </div>
  );
}

function DailyRow({ stat }: { stat: DailyStat }) {
  return (
    <div className="rounded-lg border border-border-on-surface bg-surface px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0 flex-1">
          <span className="block truncate text-on-surface">{stat.title}</span>
          <StreakLine
            current={stat.streak}
            best={stat.bestStreak}
            unit="day"
          />
        </div>
        <span className="shrink-0 text-sm font-medium text-on-surface/70">
          {stat.completedCount} / {stat.totalDays}
        </span>
      </div>
      <div
        className="mt-2 grid gap-1"
        style={{ gridTemplateColumns: `repeat(${stat.totalDays}, minmax(0, 1fr))` }}
        aria-label="Completions for each day this week"
      >
        {stat.days.map((d, i) => (
          <DayPill
            key={d.date}
            label={WEEKDAY_LABELS[i]}
            completed={d.completed}
            isFuture={d.isFuture}
            isToday={d.isToday}
          />
        ))}
      </div>
      <div
        className="mt-2 grid gap-[2px]"
        style={{ gridTemplateColumns: `repeat(${stat.heatmap.length}, minmax(0, 1fr))` }}
        aria-label="Last 30 days of completions"
      >
        {stat.heatmap.map((d) => (
          <HeatCell
            key={d.date}
            completed={d.completed}
            isToday={d.isToday}
            date={d.date}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-on-surface/50">
        <span>30 days ago</span>
        <span>Today</span>
      </div>
    </div>
  );
}

function StreakLine({
  current,
  best,
  unit,
}: {
  current: number;
  best: number;
  unit: "day" | "week";
}) {
  if (current === 0 && best === 0) return null;
  const parts: string[] = [];
  if (current > 0) parts.push(`${current}-${unit} streak`);
  if (best > current) parts.push(`best ${best}`);
  return (
    <span className="mt-0.5 inline-block text-xs text-on-surface/60">
      {parts.join(" · ")}
    </span>
  );
}

function HeatCell({
  completed,
  isToday,
  date,
}: {
  completed: boolean;
  isToday: boolean;
  date: number;
}) {
  const tone = completed ? "bg-success/80" : "bg-surface-hover";
  const ring = isToday ? " ring-1 ring-focus" : "";
  const title = new Date(date).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return (
    <div
      className={`h-3 rounded-sm ${tone}${ring}`}
      title={`${title}${completed ? " — completed" : ""}`}
    />
  );
}

function DayPill({
  label,
  completed,
  isFuture,
  isToday,
}: {
  label: string;
  completed: boolean;
  isFuture: boolean;
  isToday: boolean;
}) {
  const base =
    "flex h-7 items-center justify-center rounded text-[10px] font-medium";
  const tone = completed
    ? "bg-success/80 text-white"
    : isFuture
      ? "bg-surface-hover text-on-surface/40"
      : "bg-surface-hover text-on-surface/60";
  const ring = isToday ? " ring-1 ring-focus" : "";
  return <div className={`${base} ${tone}${ring}`}>{label}</div>;
}

function WeeklyRow({ stat }: { stat: WeeklyStat }) {
  return (
    <div className="rounded-lg border border-border-on-surface bg-surface px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0 flex-1">
          <span className="block truncate text-on-surface">{stat.title}</span>
          <StreakLine
            current={stat.streak}
            best={stat.bestStreak}
            unit="week"
          />
        </div>
        <span className="shrink-0 text-sm font-medium text-on-surface/70">
          {stat.completedCount} / {stat.totalWeeks}
        </span>
      </div>
      <div
        className="mt-2 grid gap-1"
        style={{
          gridTemplateColumns: `repeat(${stat.totalWeeks}, minmax(0, 1fr))`,
        }}
        aria-label="Completions for each week this month"
      >
        {stat.weeks.map((w, i) => (
          <WeekPill
            key={w.weekStart}
            label={`W${i + 1}`}
            completed={w.completed}
            isFuture={w.isFuture}
            isCurrent={w.isCurrent}
          />
        ))}
      </div>
    </div>
  );
}

function WeekPill({
  label,
  completed,
  isFuture,
  isCurrent,
}: {
  label: string;
  completed: boolean;
  isFuture: boolean;
  isCurrent: boolean;
}) {
  const base =
    "flex h-7 items-center justify-center rounded text-[10px] font-medium";
  const tone = completed
    ? "bg-success/80 text-white"
    : isFuture
      ? "bg-surface-hover text-on-surface/40"
      : "bg-surface-hover text-on-surface/60";
  const ring = isCurrent ? " ring-1 ring-focus" : "";
  return <div className={`${base} ${tone}${ring}`}>{label}</div>;
}
