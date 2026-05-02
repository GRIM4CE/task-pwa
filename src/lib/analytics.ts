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
  bestStreak: number;
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
  bestStreak: number;
}

export interface AtRiskTodo {
  id: string;
  title: string;
  currentStreak: number;
}

export interface GlobalStats {
  dailyCount: number;
  weeklyCount: number;
  weekCompletedDays: number;
  weekTotalDays: number;
  prevWeekCompletedDays: number;
  prevWeekTotalDays: number;
  monthCompletedWeeks: number;
  monthTotalWeeks: number;
  prevMonthCompletedWeeks: number;
  prevMonthTotalWeeks: number;
  atRiskToday: AtRiskTodo[];
  // Mon..Sun completion rate (0..1) across all daily todos over the
  // trailing 30-day window, excluding today (in-progress) and days
  // before each todo was created.
  weekdayConsistency: number[];
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

// Longest-ever consecutive-day run within the API's 120-day window.
// Uses date arithmetic rather than ms subtraction so DST transitions
// don't break the streak.
function longestDailyRun(completions: number[]): number {
  if (completions.length === 0) return 0;
  const days = [...completedDaySet(completions)].sort((a, b) => a - b);
  let best = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    const expected = addDays(new Date(days[i - 1]), 1).getTime();
    if (days[i] === expected) {
      run++;
      if (run > best) best = run;
    } else {
      run = 1;
    }
  }
  return best;
}

function longestWeeklyRun(completions: number[]): number {
  if (completions.length === 0) return 0;
  const weeks = [...completedWeekSet(completions)].sort((a, b) => a - b);
  let best = 1;
  let run = 1;
  for (let i = 1; i < weeks.length; i++) {
    const expected = addDays(new Date(weeks[i - 1]), DAYS_IN_WEEK).getTime();
    if (weeks[i] === expected) {
      run++;
      if (run > best) best = run;
    } else {
      run = 1;
    }
  }
  return best;
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
    bestStreak: longestDailyRun(todo.completions),
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
    bestStreak: longestWeeklyRun(todo.completions),
  };
}

function countCompletionsInRange(
  completions: number[],
  startMs: number,
  endMs: number
): number {
  let n = 0;
  for (const c of completions) {
    if (c >= startMs && c < endMs) n++;
  }
  return n;
}

function prevWeekCompleted(
  dailyTodos: RecurringTodoStats[],
  weekStart: Date
): number {
  const prevStart = addDays(weekStart, -DAYS_IN_WEEK).getTime();
  const prevEnd = weekStart.getTime();
  let total = 0;
  for (const t of dailyTodos) {
    // Bucket per-day so multiple completions on a single day still
    // count once, matching how the current-week ratio is computed.
    const days = new Set<number>();
    for (const c of t.completions) {
      if (c >= prevStart && c < prevEnd) {
        days.add(startOfDay(new Date(c)).getTime());
      }
    }
    total += days.size;
  }
  return total;
}

function prevMonthRange(monthStart: Date): { start: Date; end: Date } {
  const start = new Date(
    monthStart.getFullYear(),
    monthStart.getMonth() - 1,
    1,
    0,
    0,
    0,
    0
  );
  return { start, end: monthStart };
}

function prevMonthCompleted(
  weeklyTodos: RecurringTodoStats[],
  prevWeeks: { start: Date; end: Date }[]
): number {
  let total = 0;
  for (const t of weeklyTodos) {
    for (const w of prevWeeks) {
      if (
        countCompletionsInRange(t.completions, w.start.getTime(), w.end.getTime()) > 0
      ) {
        total++;
      }
    }
  }
  return total;
}

function weekdayConsistency(
  dailyTodos: RecurringTodoStats[],
  todayStart: Date
): number[] {
  const buckets: number[][] = Array.from({ length: 7 }, () => []);
  if (dailyTodos.length === 0) return buckets.map(() => 0);
  const sets = dailyTodos.map((t) => completedDaySet(t.completions));
  // Walk the past 30 days, skipping today (still in progress).
  for (let i = 1; i <= HEATMAP_DAYS; i++) {
    const day = addDays(todayStart, -i);
    const dayMs = day.getTime();
    const weekday = (day.getDay() + 6) % 7;
    let eligible = 0;
    let completed = 0;
    for (let j = 0; j < dailyTodos.length; j++) {
      if (dailyTodos[j].createdAt > dayMs) continue;
      eligible++;
      if (sets[j].has(dayMs)) completed++;
    }
    if (eligible > 0) buckets[weekday].push(completed / eligible);
  }
  return buckets.map((arr) =>
    arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length
  );
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

  const prevWeekCompletedDays = prevWeekCompleted(dailyTodos, weekStart);
  const prevWeekTotalDays = dailyTodos.length * DAYS_IN_WEEK;

  const prevMonth = prevMonthRange(monthStart);
  const prevMonthWeeks = weeksInMonth(prevMonth.start, prevMonth.end);
  const prevMonthCompletedWeeks = prevMonthCompleted(weeklyTodos, prevMonthWeeks);
  const prevMonthTotalWeeks = weeklyTodos.length * prevMonthWeeks.length;

  const atRiskToday: AtRiskTodo[] = daily
    .filter((d) => {
      const todayCell = d.days.find((c) => c.isToday);
      return d.streak > 0 && !todayCell?.completed;
    })
    .map((d) => ({ id: d.id, title: d.title, currentStreak: d.streak }));

  return {
    daily,
    weekly,
    global: {
      dailyCount: daily.length,
      weeklyCount: weekly.length,
      weekCompletedDays,
      weekTotalDays,
      prevWeekCompletedDays,
      prevWeekTotalDays,
      monthCompletedWeeks,
      monthTotalWeeks,
      prevMonthCompletedWeeks,
      prevMonthTotalWeeks,
      atRiskToday,
      weekdayConsistency: weekdayConsistency(dailyTodos, todayStart),
    },
  };
}

export function percent(num: number, denom: number): number {
  if (denom === 0) return 0;
  return Math.round((num / denom) * 100);
}
