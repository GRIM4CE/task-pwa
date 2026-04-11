import { db, schema } from "@/db";

export type AuditAction =
  | "login_success"
  | "login_failed"
  | "logout"
  | "totp_setup"
  | "totp_reset"
  | "recovery_code_used"
  | "session_created"
  | "session_revoked"
  | "account_locked";

export async function logAudit(
  action: AuditAction,
  options: {
    userId?: string;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
  } = {}
): Promise<void> {
  await db.insert(schema.auditLog).values({
    userId: options.userId ?? null,
    action,
    ipAddress: options.ipAddress ?? null,
    userAgent: options.userAgent ?? null,
    metadata: options.metadata ? JSON.stringify(options.metadata) : null,
  });
}
