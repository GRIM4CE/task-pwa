export type Recurrence =
  | "daily"
  | "weekly"
  | "weekday"
  | "monthly_day"
  | "monthly_weekday"
  | null;

export type RecurrenceOrdinal =
  | "first"
  | "second"
  | "third"
  | "fourth"
  | "last"
  | null;

// Subset of TodoDTO needed to evaluate scheduled-recurrence visibility/reset.
// Kept minimal so server-side row shapes (with Date timestamps) can satisfy it
// after .getTime() conversion.
export type RecurrenceTodo = {
  recurrence: Recurrence;
  recurrenceWeekday: number | null;
  recurrenceDayOfMonth: number | null;
  recurrenceOrdinal: RecurrenceOrdinal;
  createdAt: number;
  lastCompletedAt: number | null;
};

// "Scheduled" recurrences only surface on their target day(s) — they're hidden
// the rest of the time and treat completion as "done for this occurrence".
// Distinct from daily/weekly which stay visible and reset on a fixed boundary.
export function isScheduledRecurrence(r: Recurrence): boolean {
  return r === "weekday" || r === "monthly_day" || r === "monthly_weekday";
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function lastDayOfMonth(year: number, month: number): number {
  // month is 0-indexed; day 0 of next month = last day of current month.
  return new Date(year, month + 1, 0).getDate();
}

// "monthly_day" anchors to a calendar day. If the requested day exceeds the
// month's length (e.g., the 31st in February), fall back to the last day of
// that month so the occurrence still happens once per month.
function clampDayOfMonth(year: number, month: number, day: number): number {
  return Math.min(day, lastDayOfMonth(year, month));
}

// Compute the date in the given month that matches an ordinal+weekday
// (e.g., "first Friday" of March). Every weekday occurs at least 4 times in
// every month (28-day Feb covers exactly 4), so first/second/third/fourth
// always exist; "last" returns the final occurrence in the month.
function ordinalWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  ordinal: Exclude<RecurrenceOrdinal, null>
): number {
  if (ordinal === "last") {
    const last = lastDayOfMonth(year, month);
    const lastWeekday = new Date(year, month, last).getDay();
    const offset = (lastWeekday - weekday + 7) % 7;
    return last - offset;
  }
  const ordinalIndex =
    ordinal === "first" ? 0 : ordinal === "second" ? 1 : ordinal === "third" ? 2 : 3;
  const firstWeekday = new Date(year, month, 1).getDay();
  const firstMatch = 1 + ((weekday - firstWeekday + 7) % 7);
  return firstMatch + ordinalIndex * 7;
}

// Most-recent scheduled occurrence date (start-of-local-day) at or before
// `now`. Returns null only for non-scheduled recurrences. Used for both
// visibility (is the current occurrence open?) and reset detection (has a
// new occurrence arrived since lastCompletedAt?).
export function mostRecentScheduledDate(
  todo: Pick<
    RecurrenceTodo,
    "recurrence" | "recurrenceWeekday" | "recurrenceDayOfMonth" | "recurrenceOrdinal"
  >,
  now: number = Date.now()
): Date | null {
  if (!isScheduledRecurrence(todo.recurrence)) return null;
  const today = startOfLocalDay(new Date(now));

  if (todo.recurrence === "weekday") {
    const target = todo.recurrenceWeekday;
    if (target === null) return null;
    const offset = (today.getDay() - target + 7) % 7;
    return new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - offset,
      0,
      0,
      0,
      0
    );
  }

  if (todo.recurrence === "monthly_day") {
    const target = todo.recurrenceDayOfMonth;
    if (target === null) return null;
    const thisMonthDay = clampDayOfMonth(
      today.getFullYear(),
      today.getMonth(),
      target
    );
    if (today.getDate() >= thisMonthDay) {
      return new Date(today.getFullYear(), today.getMonth(), thisMonthDay);
    }
    const prevMonth = today.getMonth() - 1;
    const prevYear = prevMonth < 0 ? today.getFullYear() - 1 : today.getFullYear();
    const normMonth = (prevMonth + 12) % 12;
    const prevMonthDay = clampDayOfMonth(prevYear, normMonth, target);
    return new Date(prevYear, normMonth, prevMonthDay);
  }

  // monthly_weekday
  const wd = todo.recurrenceWeekday;
  const ord = todo.recurrenceOrdinal;
  if (wd === null || ord === null) return null;
  const thisMonthOcc = ordinalWeekdayOfMonth(
    today.getFullYear(),
    today.getMonth(),
    wd,
    ord
  );
  if (today.getDate() >= thisMonthOcc) {
    return new Date(today.getFullYear(), today.getMonth(), thisMonthOcc);
  }
  const prevMonth = today.getMonth() - 1;
  const prevYear = prevMonth < 0 ? today.getFullYear() - 1 : today.getFullYear();
  const normMonth = (prevMonth + 12) % 12;
  const prevMonthOcc = ordinalWeekdayOfMonth(prevYear, normMonth, wd, ord);
  return new Date(prevYear, normMonth, prevMonthOcc);
}

// Next scheduled occurrence date (start-of-local-day) strictly after the
// local-day floor of `now`. Returns null only for non-scheduled recurrences.
// Mirrors the anchor logic in mostRecentScheduledDate, including day-of-month
// clamping for short months and ordinal+weekday derivation per month — so
// month-end edge cases (e.g. the 31st in February) and the weekday/ordinal
// shape land on the right calendar date instead of drifting via naive
// month arithmetic on a JS Date.
export function nextScheduledDate(
  todo: Pick<
    RecurrenceTodo,
    "recurrence" | "recurrenceWeekday" | "recurrenceDayOfMonth" | "recurrenceOrdinal"
  >,
  now: number = Date.now()
): Date | null {
  if (!isScheduledRecurrence(todo.recurrence)) return null;
  const today = startOfLocalDay(new Date(now));

  if (todo.recurrence === "weekday") {
    const target = todo.recurrenceWeekday;
    if (target === null) return null;
    const offset = (target - today.getDay() + 7) % 7;
    const days = offset === 0 ? 7 : offset;
    return new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() + days
    );
  }

  if (todo.recurrence === "monthly_day") {
    const target = todo.recurrenceDayOfMonth;
    if (target === null) return null;
    const thisMonthDay = clampDayOfMonth(
      today.getFullYear(),
      today.getMonth(),
      target
    );
    if (today.getDate() < thisMonthDay) {
      return new Date(today.getFullYear(), today.getMonth(), thisMonthDay);
    }
    const rawMonth = today.getMonth() + 1;
    const nextYear = rawMonth > 11 ? today.getFullYear() + 1 : today.getFullYear();
    const nextMonth = rawMonth % 12;
    const nextDay = clampDayOfMonth(nextYear, nextMonth, target);
    return new Date(nextYear, nextMonth, nextDay);
  }

  // monthly_weekday
  const wd = todo.recurrenceWeekday;
  const ord = todo.recurrenceOrdinal;
  if (wd === null || ord === null) return null;
  const thisMonthOcc = ordinalWeekdayOfMonth(
    today.getFullYear(),
    today.getMonth(),
    wd,
    ord
  );
  if (today.getDate() < thisMonthOcc) {
    return new Date(today.getFullYear(), today.getMonth(), thisMonthOcc);
  }
  const rawMonth = today.getMonth() + 1;
  const nextYear = rawMonth > 11 ? today.getFullYear() + 1 : today.getFullYear();
  const nextMonth = rawMonth % 12;
  const nextOcc = ordinalWeekdayOfMonth(nextYear, nextMonth, wd, ord);
  return new Date(nextYear, nextMonth, nextOcc);
}

// True when a "scheduled" todo's current occurrence is open and should appear
// in the active list. Hidden the rest of the time. For non-scheduled rows
// (daily/weekly/null) this returns true — those are visibility-filtered
// elsewhere (recurring stays visible; null follows the 24h-after-complete
// rule). Caller still has to filter on `completed`.
export function isScheduledOccurrenceOpen(
  todo: RecurrenceTodo,
  now: number = Date.now()
): boolean {
  if (!isScheduledRecurrence(todo.recurrence)) return true;
  const mostRecent = mostRecentScheduledDate(todo, now);
  if (!mostRecent) return false;
  // Reference is the floor of whichever is more recent: createdAt (so a
  // scheduled todo doesn't surface for the previous occurrence that happened
  // before it was even made) or lastCompletedAt (so completing this occurrence
  // hides the row until the next one, even though we don't auto-reset for
  // scheduled types).
  const createdFloor = startOfLocalDay(new Date(todo.createdAt)).getTime();
  const lastFloor =
    todo.lastCompletedAt !== null
      ? startOfLocalDay(new Date(todo.lastCompletedAt)).getTime()
      : -Infinity;
  if (lastFloor >= mostRecent.getTime()) return false;
  return mostRecent.getTime() >= createdFloor;
}

// A completed recurring todo is "due" for reset at the start of the next
// recurrence period in the user's local timezone:
//   - daily    → 00:00 the calendar day after lastCompletedAt
//   - weekly   → 00:00 the Monday after the ISO week containing lastCompletedAt
//   - scheduled (weekday / monthly_day / monthly_weekday) → the next scheduled
//     occurrence date strictly after lastCompletedAt's local date
// Weekly tasks therefore stay ticked off through the rest of the week and only
// clear at the Sunday→Monday boundary, regardless of which day they were
// completed. Scheduled tasks reset the moment a new occurrence's date arrives,
// not on a generic boundary. Using local Date components honors the browser's
// IANA timezone (including DST).
export function isRecurringResetDue(
  todo: RecurrenceTodo,
  now: number = Date.now()
): boolean {
  const { recurrence, lastCompletedAt } = todo;
  if (recurrence === null || lastCompletedAt === null) return false;
  const last = new Date(lastCompletedAt);

  if (recurrence === "weekly") {
    const daysSinceMonday = (last.getDay() + 6) % 7;
    const resetAt = new Date(
      last.getFullYear(),
      last.getMonth(),
      last.getDate() - daysSinceMonday + 7,
      0,
      0,
      0,
      0
    );
    return now >= resetAt.getTime();
  }

  if (recurrence === "daily") {
    const resetAt = new Date(
      last.getFullYear(),
      last.getMonth(),
      last.getDate() + 1,
      0,
      0,
      0,
      0
    );
    return now >= resetAt.getTime();
  }

  // Scheduled recurrences: reset when the most recent occurrence date is
  // strictly after the local-date floor of lastCompletedAt.
  const mostRecent = mostRecentScheduledDate(todo, now);
  if (!mostRecent) return false;
  const lastFloor = startOfLocalDay(last).getTime();
  return mostRecent.getTime() > lastFloor;
}

// A completed non-recurring todo (or subtask) should be removed once the
// user's local clock has crossed the next midnight after lastCompletedAt.
// Mirrors isRecurringResetDue so cleanup honors the browser's IANA timezone.
export function isCompletedTodoExpired(
  lastCompletedAt: number | null,
  now: number = Date.now()
): boolean {
  if (lastCompletedAt === null) return false;
  const last = new Date(lastCompletedAt);
  const expiresAt = new Date(
    last.getFullYear(),
    last.getMonth(),
    last.getDate() + 1,
    0,
    0,
    0,
    0
  );
  return now >= expiresAt.getTime();
}

