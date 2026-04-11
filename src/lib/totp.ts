import * as OTPAuth from "otpauth";
import { encrypt, decrypt } from "./crypto";
import { env } from "./env";

const ISSUER = "Todo";

export function generateTotpSecret(username: string): {
  secret: string;
  uri: string;
  encryptedSecret: string;
  encryptionIv: string;
} {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: username,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  });

  const rawSecret = totp.secret.base32;
  const { encrypted, iv } = encrypt(rawSecret, env.appSecret);

  return {
    secret: rawSecret,
    uri: totp.toString(),
    encryptedSecret: encrypted,
    encryptionIv: iv,
  };
}

export function verifyTotp(
  encryptedSecret: string,
  encryptionIv: string,
  code: string
): { valid: boolean; timeStep: number } {
  const rawSecret = decrypt(encryptedSecret, encryptionIv, env.appSecret);

  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(rawSecret),
  });

  // Allow window of +/-1 (30 seconds clock drift)
  const delta = totp.validate({ token: code, window: 1 });
  const currentTimeStep = Math.floor(Date.now() / 1000 / 30);

  return {
    valid: delta !== null,
    timeStep: currentTimeStep,
  };
}

export function getTotpUri(encryptedSecret: string, encryptionIv: string, username: string): string {
  const rawSecret = decrypt(encryptedSecret, encryptionIv, env.appSecret);

  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: username,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(rawSecret),
  });

  return totp.toString();
}
