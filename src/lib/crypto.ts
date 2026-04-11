import { createCipheriv, createDecipheriv, randomBytes, createHash, pbkdf2Sync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT = "home-app-totp-encryption"; // Static salt, combined with APP_SECRET

function deriveKey(secret: string): Buffer {
  return pbkdf2Sync(secret, SALT, 100000, 32, "sha256");
}

export function encrypt(plaintext: string, secret: string): { encrypted: string; iv: string } {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return {
    encrypted: encrypted + ":" + authTag,
    iv: iv.toString("hex"),
  };
}

export function decrypt(encryptedData: string, iv: string, secret: string): string {
  const key = deriveKey(secret);
  const [encrypted, authTag] = encryptedData.split(":");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "hex"), {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(Buffer.from(authTag, "hex"));

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function generateRecoveryCode(): string {
  // 8 character alphanumeric recovery code
  const chars = "abcdefghjkmnpqrstuvwxyz23456789"; // No ambiguous chars (0/O, 1/l/I)
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.toLowerCase()).digest("hex");
}
