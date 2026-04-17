export type Recurrence = "daily" | "weekly" | null;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export function recurrencePeriodMs(recurrence: Recurrence): number | null {
  if (recurrence === "daily") return DAY_MS;
  if (recurrence === "weekly") return WEEK_MS;
  return null;
}

// A completed recurring todo is "due" for reset once the rolling period since
// it was last completed has fully elapsed.
export function isRecurringResetDue(
  recurrence: Recurrence,
  lastCompletedAt: number | null,
  now: number = Date.now()
): boolean {
  const period = recurrencePeriodMs(recurrence);
  if (period === null || lastCompletedAt === null) return false;
  return now - lastCompletedAt >= period;
}
