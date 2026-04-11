function getEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const env = {
  get appSecret() {
    return getEnv("APP_SECRET");
  },
  get appUsername() {
    return getEnv("APP_USERNAME", "admin");
  },
  get nodeEnv() {
    return getEnv("NODE_ENV", "development");
  },
  get isProduction() {
    return this.nodeEnv === "production";
  },
};
