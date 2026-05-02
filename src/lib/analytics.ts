import type {
  AvoidTodoStats,
  LimitPeriod,
  RecurringTodoStats,
} from "@/lib/api-client";

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
  // Days in the prior week where at least one daily todo existed at
  // the start of the day. Zero when there's no comparable history,
  // which the UI uses to hide the velocity delta.
  prevWeekEligibleDays: number;
  monthCompletedWeeks: number;
  monthTotalWeeks: number;
  prevMonthCompletedWeeks: number;
  prevMonthEligibleWeeks: number;
  atRiskToday: AtRiskTodo[];
  // Mon..Sun completion summary across all daily todos over the
  // trailing 30-day window, excluding today (in-progress) and days
  // before each todo was created. `rate` is null when no eligible
  // samples landed in the bucket.
  weekdayConsistency: WeekdayConsistencyEntry[];
}

export interface ComputedStats {
  daily: DailyStat[];
  weekly: WeeklyStat[];
  avoid: AvoidStat[];
  global: GlobalStats;
}

export type AvoidStatus = "ok" | "warn" | "over";

export interface AvoidStat {
  id: string;
  title: string;
  limitCount: number | null;
  limitPeriod: LimitPeriod;
  // Slips inside the rolling window (last 7 / last 30 days). For unlimited
  // avoid-todos we still report a 30-day count for context.
  windowSlipCount: number;
  windowDays: number;
  // Slips ever recorded (within the API's 120-day retention).
  totalSlips: number;
  status: AvoidStatus;
  // Days since the most recent slip — null when there's never been one.
  daysClean: number | null;
  bestStreakDays: number;
  // Last 30 days of slips for a sparkline-style heatmap.
  heatmap: AvoidHeatCell[];
  // Milestone hit by `daysClean` (e.g. 7, 14, 30, 60, 90), or null when
  // none has been reached yet.
  milestone: number | null;
}

export interface AvoidHeatCell {
  date: number;
  slips: number;
  isToday: boolean;
}

const AVOID_HEATMAP_DAYS = 30;
const AVOID_MILESTONES = [365, 180, 90, 60, 30, 14, 7];
// Threshold for the warning state: if you're within this fraction of your
// limit (but not yet at it), flag the card amber so it's actionable before
// you cross the line.
const AVOID_WARN_RATIO = 0.8;

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

// Eligibility-aware prev-week aggregate: a daily todo only contributes
// (createdAt, day) pairs where it actually existed at the start of the
// day, so a todo created mid-period doesn't deflate the prior-period
// percentage with phantom 0s.
function prevWeekStats(
  dailyTodos: RecurringTodoStats[],
  weekStart: Date
): { completed: number; eligible: number } {
  const prevStart = addDays(weekStart, -DAYS_IN_WEEK);
  const prevEndMs = weekStart.getTime();
  let completed = 0;
  let eligible = 0;
  for (const t of dailyTodos) {
    const completedDays = new Set<number>();
    for (const c of t.completions) {
      if (c >= prevStart.getTime() && c < prevEndMs) {
        completedDays.add(startOfDay(new Date(c)).getTime());
      }
    }
    for (let i = 0; i < DAYS_IN_WEEK; i++) {
      const dayMs = addDays(prevStart, i).getTime();
      if (t.createdAt > dayMs) continue;
      eligible++;
      if (completedDays.has(dayMs)) completed++;
    }
  }
  return { completed, eligible };
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

// Eligibility-aware prev-month aggregate: only weeks where the weekly
// todo existed at the start of the week count toward the denominator.
function prevMonthStats(
  weeklyTodos: RecurringTodoStats[],
  prevWeeks: { start: Date; end: Date }[]
): { completed: number; eligible: number } {
  let completed = 0;
  let eligible = 0;
  for (const t of weeklyTodos) {
    for (const w of prevWeeks) {
      if (t.createdAt > w.start.getTime()) continue;
      eligible++;
      if (
        countCompletionsInRange(t.completions, w.start.getTime(), w.end.getTime()) > 0
      ) {
        completed++;
      }
    }
  }
  return { completed, eligible };
}

export interface WeekdayConsistencyEntry {
  // null when no eligible samples landed in this weekday in the
  // 30-day window (e.g., todo too new). Distinguishes "no data"
  // from a genuine 0% completion day.
  rate: number | null;
  samples: number;
}

function weekdayConsistency(
  dailyTodos: RecurringTodoStats[],
  todayStart: Date
): WeekdayConsistencyEntry[] {
  const buckets: number[][] = Array.from({ length: 7 }, () => []);
  if (dailyTodos.length === 0) {
    return buckets.map(() => ({ rate: null, samples: 0 }));
  }
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
    arr.length === 0
      ? { rate: null, samples: 0 }
      : {
          rate: arr.reduce((a, b) => a + b, 0) / arr.length,
          samples: arr.length,
        }
  );
}

export function computeStats(
  todos: RecurringTodoStats[],
  now: Date = new Date(),
  avoidTodos: AvoidTodoStats[] = []
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
  const avoid = avoidTodos.map((t) => avoidForTodo(t, todayStart, now));

  const weekCompletedDays = daily.reduce((acc, d) => acc + d.completedCount, 0);
  const weekTotalDays = daily.length * DAYS_IN_WEEK;
  const monthCompletedWeeks = weekly.reduce(
    (acc, w) => acc + w.completedCount,
    0
  );
  const monthTotalWeeks = weekly.length * monthWeeks.length;

  const prevWeek = prevWeekStats(dailyTodos, weekStart);

  const prevMonth = prevMonthRange(monthStart);
  const prevMonthWeeks = weeksInMonth(prevMonth.start, prevMonth.end);
  const prevMonthAgg = prevMonthStats(weeklyTodos, prevMonthWeeks);

  const atRiskToday: AtRiskTodo[] = daily
    .filter((d) => {
      const todayCell = d.days.find((c) => c.isToday);
      return d.streak > 0 && !todayCell?.completed;
    })
    .map((d) => ({ id: d.id, title: d.title, currentStreak: d.streak }));

  return {
    daily,
    weekly,
    avoid,
    global: {
      dailyCount: daily.length,
      weeklyCount: weekly.length,
      weekCompletedDays,
      weekTotalDays,
      prevWeekCompletedDays: prevWeek.completed,
      prevWeekEligibleDays: prevWeek.eligible,
      monthCompletedWeeks,
      monthTotalWeeks,
      prevMonthCompletedWeeks: prevMonthAgg.completed,
      prevMonthEligibleWeeks: prevMonthAgg.eligible,
      atRiskToday,
      weekdayConsistency: weekdayConsistency(dailyTodos, todayStart),
    },
  };
}

export function percent(num: number, denom: number): number {
  if (denom === 0) return 0;
  return Math.round((num / denom) * 100);
}

// Calendar-window start: the most recent ISO Monday for "week" limits, or
// the 1st of the current month for "month" limits. Returned in local time so
// the boundary lines up with the user's clock (and matches the recurrence
// reset). For unlimited avoid-todos with no period, falls back to a 30-day
// rolling cutoff so the card still has something to display.
export function avoidWindowStart(period: LimitPeriod, now: Date): Date {
  if (period === "week") return startOfWeek(now);
  if (period === "month") return startOfMonth(now);
  return new Date(startOfDay(now).getTime() - (AVOID_HEATMAP_DAYS - 1) * 24 * 60 * 60 * 1000);
}

// Days in the current calendar period — used by the card to surface a count
// like "3 / 5 this week" without committing to a specific implementation of
// the boundary check.
export function avoidWindowDays(period: LimitPeriod, now: Date): number {
  const start = avoidWindowStart(period, now);
  if (period === "week") return DAYS_IN_WEEK;
  if (period === "month") {
    const end = startOfNextMonth(now);
    return Math.round(
      (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)
    );
  }
  return AVOID_HEATMAP_DAYS;
}

function countSlipsInWindow(
  completions: number[],
  windowStart: number
): number {
  return completions.reduce((n, ts) => (ts >= windowStart ? n + 1 : n), 0);
}

function avoidStatus(
  count: number,
  limit: number | null
): AvoidStatus {
  if (limit === null || limit <= 0) return "ok";
  if (count >= limit) return "over";
  if (count >= Math.ceil(limit * AVOID_WARN_RATIO)) return "warn";
  return "ok";
}

function daysSinceLastSlip(
  completions: number[],
  todayStart: Date
): number | null {
  if (completions.length === 0) return null;
  const last = Math.max(...completions);
  const lastDay = startOfDay(new Date(last)).getTime();
  return Math.max(
    0,
    Math.round((todayStart.getTime() - lastDay) / (24 * 60 * 60 * 1000))
  );
}

// Best streak = longest run of consecutive whole days with no slip recorded,
// looking back through the available completion history (capped by the API's
// 120-day window). The most recent gap is included so an in-progress streak
// can become the new best.
function bestCleanStreak(
  completions: number[],
  todoCreatedAt: number,
  now: number
): number {
  const dayMs = 24 * 60 * 60 * 1000;
  const sorted = [...completions].sort((a, b) => a - b);
  // Anchors: the todo's creation (no slips before it could exist) and the
  // current moment (so the in-progress gap counts).
  const anchors = [todoCreatedAt, ...sorted, now];
  let best = 0;
  for (let i = 1; i < anchors.length; i++) {
    const days = Math.floor((anchors[i] - anchors[i - 1]) / dayMs);
    if (days > best) best = days;
  }
  return best;
}

function avoidHeatmap(
  completions: number[],
  todayStart: Date
): AvoidHeatCell[] {
  // Bucket slips by start-of-day so a day with multiple slips renders darker.
  const bucket = new Map<number, number>();
  for (const ts of completions) {
    const day = startOfDay(new Date(ts)).getTime();
    bucket.set(day, (bucket.get(day) ?? 0) + 1);
  }
  const cells: AvoidHeatCell[] = [];
  for (let i = AVOID_HEATMAP_DAYS - 1; i >= 0; i--) {
    const day = addDays(todayStart, -i);
    const startMs = day.getTime();
    cells.push({
      date: startMs,
      slips: bucket.get(startMs) ?? 0,
      isToday: i === 0,
    });
  }
  return cells;
}

function milestoneFor(daysClean: number | null): number | null {
  if (daysClean === null) return null;
  for (const m of AVOID_MILESTONES) {
    if (daysClean >= m) return m;
  }
  return null;
}

function avoidForTodo(
  todo: AvoidTodoStats,
  todayStart: Date,
  now: Date
): AvoidStat {
  const windowStart = avoidWindowStart(todo.limitPeriod, now).getTime();
  const windowDays = avoidWindowDays(todo.limitPeriod, now);
  const windowSlipCount = countSlipsInWindow(todo.completions, windowStart);
  const totalSlips = todo.completions.length;
  const status = avoidStatus(windowSlipCount, todo.limitCount);
  const daysClean = daysSinceLastSlip(todo.completions, todayStart);
  const bestStreakDays = bestCleanStreak(
    todo.completions,
    todo.createdAt,
    now.getTime()
  );
  return {
    id: todo.id,
    title: todo.title,
    limitCount: todo.limitCount,
    limitPeriod: todo.limitPeriod,
    windowSlipCount,
    windowDays,
    totalSlips,
    status,
    daysClean,
    bestStreakDays,
    heatmap: avoidHeatmap(todo.completions, todayStart),
    milestone: milestoneFor(daysClean),
  };
}

// Public so the todo card can compute the same status without redoing the
// arithmetic. Only needs the per-todo info available in the list view.
export function avoidStatusForTodo(
  completions: number[],
  limitCount: number | null,
  limitPeriod: LimitPeriod,
  now: number = Date.now()
): { count: number; status: AvoidStatus; windowDays: number } {
  const nowDate = new Date(now);
  const windowStart = avoidWindowStart(limitPeriod, nowDate).getTime();
  const windowDays = avoidWindowDays(limitPeriod, nowDate);
  const count = countSlipsInWindow(completions, windowStart);
  return { count, status: avoidStatus(count, limitCount), windowDays };
}

// Whether the given completion list contains a slip on today's local
// calendar day. Used by the once-per-day card mode to decide whether the
// +1 button should be disabled.
export function hasSlipToday(
  completions: number[],
  now: number = Date.now()
): boolean {
  const todayStart = startOfDay(new Date(now)).getTime();
  const tomorrowStart = todayStart + 24 * 60 * 60 * 1000;
  return completions.some((ts) => ts >= todayStart && ts < tomorrowStart);
}
