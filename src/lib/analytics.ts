import type { RecurringTodoStats } from "@/lib/api-client";

// Week starts on Monday (ISO 8601). All boundaries are computed in the
// browser's local timezone so they match the recurrence reset logic.
const DAYS_IN_WEEK = 7;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function startOfWeek(d: Date): Date {
  const day = startOfDay(d);
  // getDay(): 0=Sun..6=Sat. Shift so Monday = 0.
  const offset = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - offset);
  return day;
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function startOfNextMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0);
}

export interface DayCell {
  date: number; // start-of-day timestamp
  completed: boolean;
  isFuture: boolean;
  isToday: boolean;
}

export interface DailyStat {
  id: string;
  title: string;
  completedCount: number;
  totalDays: number;
  days: DayCell[];
  streak: number;
  heatmap: DayCell[];
}

export interface WeekCell {
  weekStart: number;
  weekEnd: number; // exclusive
  completed: boolean;
  isFuture: boolean;
  isCurrent: boolean;
  label: string;
}

export interface WeeklyStat {
  id: string;
  title: string;
  completedCount: number;
  totalWeeks: number;
  weeks: WeekCell[];
  streak: number;
}

export interface GlobalStats {
  dailyCount: number;
  weeklyCount: number;
  weekCompletedDays: number;
  weekTotalDays: number;
  monthCompletedWeeks: number;
  monthTotalWeeks: number;
}

export interface ComputedStats {
  daily: DailyStat[];
  weekly: WeeklyStat[];
  global: GlobalStats;
}

const HEATMAP_DAYS = 30;

function completedDaySet(completions: number[]): Set<number> {
  const set = new Set<number>();
  for (const ts of completions) {
    set.add(startOfDay(new Date(ts)).getTime());
  }
  return set;
}

function completedWeekSet(completions: number[]): Set<number> {
  const set = new Set<number>();
  for (const ts of completions) {
    set.add(startOfWeek(new Date(ts)).getTime());
  }
  return set;
}

// Walks backward from today (or yesterday, if today isn't done yet so an
// in-progress day doesn't break the streak) counting consecutive completed
// days. Capped indirectly by the API's 120-day completions window.
function dailyStreak(completions: number[], todayStart: Date): number {
  if (completions.length === 0) return 0;
  const days = completedDaySet(completions);
  const today = todayStart.getTime();
  const yesterday = addDays(todayStart, -1).getTime();
  let cursor: number;
  if (days.has(today)) cursor = today;
  else if (days.has(yesterday)) cursor = yesterday;
  else return 0;
  let count = 0;
  while (days.has(cursor)) {
    count++;
    cursor = addDays(new Date(cursor), -1).getTime();
  }
  return count;
}

function weeklyStreak(completions: number[], thisWeekStart: Date): number {
  if (completions.length === 0) return 0;
  const weeks = completedWeekSet(completions);
  const thisWeek = thisWeekStart.getTime();
  const lastWeek = addDays(thisWeekStart, -DAYS_IN_WEEK).getTime();
  let cursor: number;
  if (weeks.has(thisWeek)) cursor = thisWeek;
  else if (weeks.has(lastWeek)) cursor = lastWeek;
  else return 0;
  let count = 0;
  while (weeks.has(cursor)) {
    count++;
    cursor = addDays(new Date(cursor), -DAYS_IN_WEEK).getTime();
  }
  return count;
}

function dailyHeatmap(completions: number[], todayStart: Date): DayCell[] {
  const days = completedDaySet(completions);
  const cells: DayCell[] = [];
  for (let i = HEATMAP_DAYS - 1; i >= 0; i--) {
    const dayStart = addDays(todayStart, -i);
    const startMs = dayStart.getTime();
    cells.push({
      date: startMs,
      completed: days.has(startMs),
      isFuture: false,
      isToday: i === 0,
    });
  }
  return cells;
}

function dailyForTodo(
  todo: RecurringTodoStats,
  weekStart: Date,
  todayStart: Date
): DailyStat {
  const days: DayCell[] = [];
  let completedCount = 0;
  for (let i = 0; i < DAYS_IN_WEEK; i++) {
    const dayStart = addDays(weekStart, i);
    const dayEnd = addDays(weekStart, i + 1);
    const startMs = dayStart.getTime();
    const endMs = dayEnd.getTime();
    const completed = todo.completions.some(
      (c) => c >= startMs && c < endMs
    );
    if (completed) completedCount++;
    days.push({
      date: startMs,
      completed,
      isFuture: dayStart.getTime() > todayStart.getTime(),
      isToday: dayStart.getTime() === todayStart.getTime(),
    });
  }
  return {
    id: todo.id,
    title: todo.title,
    completedCount,
    totalDays: DAYS_IN_WEEK,
    days,
    streak: dailyStreak(todo.completions, todayStart),
    heatmap: dailyHeatmap(todo.completions, todayStart),
  };
}

function weeksInMonth(monthStart: Date, monthEnd: Date): { start: Date; end: Date }[] {
  const weeks: { start: Date; end: Date }[] = [];
  let cursor = startOfWeek(monthStart);
  while (cursor.getTime() < monthEnd.getTime()) {
    weeks.push({ start: cursor, end: addDays(cursor, DAYS_IN_WEEK) });
    cursor = addDays(cursor, DAYS_IN_WEEK);
  }
  return weeks;
}

function weeklyForTodo(
  todo: RecurringTodoStats,
  weeks: { start: Date; end: Date }[],
  thisWeekStart: Date
): WeeklyStat {
  let completedCount = 0;
  const cells: WeekCell[] = weeks.map((w, i) => {
    const startMs = w.start.getTime();
    const endMs = w.end.getTime();
    const completed = todo.completions.some(
      (c) => c >= startMs && c < endMs
    );
    if (completed) completedCount++;
    return {
      weekStart: startMs,
      weekEnd: endMs,
      completed,
      isFuture: startMs > thisWeekStart.getTime(),
      isCurrent: startMs === thisWeekStart.getTime(),
      label: `Week ${i + 1}`,
    };
  });
  return {
    id: todo.id,
    title: todo.title,
    completedCount,
    totalWeeks: cells.length,
    weeks: cells,
    streak: weeklyStreak(todo.completions, thisWeekStart),
  };
}

export function computeStats(
  todos: RecurringTodoStats[],
  now: Date = new Date()
): ComputedStats {
  const todayStart = startOfDay(now);
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);
  const monthEnd = startOfNextMonth(now);
  const monthWeeks = weeksInMonth(monthStart, monthEnd);

  const dailyTodos = todos.filter((t) => t.recurrence === "daily");
  const weeklyTodos = todos.filter((t) => t.recurrence === "weekly");

  const daily = dailyTodos.map((t) => dailyForTodo(t, weekStart, todayStart));
  const weekly = weeklyTodos.map((t) => weeklyForTodo(t, monthWeeks, weekStart));

  const weekCompletedDays = daily.reduce((acc, d) => acc + d.completedCount, 0);
  const weekTotalDays = daily.length * DAYS_IN_WEEK;
  const monthCompletedWeeks = weekly.reduce(
    (acc, w) => acc + w.completedCount,
    0
  );
  const monthTotalWeeks = weekly.length * monthWeeks.length;

  return {
    daily,
    weekly,
    global: {
      dailyCount: daily.length,
      weeklyCount: weekly.length,
      weekCompletedDays,
      weekTotalDays,
      monthCompletedWeeks,
      monthTotalWeeks,
    },
  };
}

export function percent(num: number, denom: number): number {
  if (denom === 0) return 0;
  return Math.round((num / denom) * 100);
}
