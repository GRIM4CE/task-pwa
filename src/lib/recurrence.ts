export type Recurrence = "daily" | "weekly" | null;

// A completed recurring todo is "due" for reset at the start of the next
// recurrence period in the user's local timezone:
//   - daily   → 00:00 the calendar day after lastCompletedAt
//   - weekly  → 00:00 the Monday after the ISO week containing lastCompletedAt
// Weekly tasks therefore stay ticked off through the rest of the week and
// only clear at the Sunday→Monday boundary, regardless of which day they
// were completed. Using local Date components honors the browser's IANA
// timezone (including DST).
export function isRecurringResetDue(
  recurrence: Recurrence,
  lastCompletedAt: number | null,
  now: number = Date.now()
): boolean {
  if (recurrence === null || lastCompletedAt === null) return false;
  const last = new Date(lastCompletedAt);

  if (recurrence === "weekly") {
    // getDay(): 0=Sun..6=Sat. Treat Monday as the start of the week, so
    // a Sunday completion clears at the upcoming midnight (1 day later)
    // and a Monday completion clears 7 days later.
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
