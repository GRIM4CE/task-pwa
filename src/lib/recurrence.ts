export type Recurrence = "daily" | "weekly" | null;

// A completed recurring todo is "due" for reset once the user's local clock
// has crossed the next midnight boundary after lastCompletedAt:
//   - daily:  00:00 the next local calendar day
//   - weekly: 00:00 seven local calendar days later
// Using local Date components honors the browser's IANA timezone (including DST).
export function isRecurringResetDue(
  recurrence: Recurrence,
  lastCompletedAt: number | null,
  now: number = Date.now()
): boolean {
  if (recurrence === null || lastCompletedAt === null) return false;
  const last = new Date(lastCompletedAt);
  const daysToAdd = recurrence === "daily" ? 1 : 7;
  const resetAt = new Date(
    last.getFullYear(),
    last.getMonth(),
    last.getDate() + daysToAdd,
    0,
    0,
    0,
    0
  );
  return now >= resetAt.getTime();
}
