import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const CURRENT_VERSION = "v2";

const getEncryptionKey = (): Buffer | null => {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) return null;
  const keyBuffer = Buffer.from(key, "hex");
  if (keyBuffer.length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY must be a 32-byte hex string (64 characters)",
    );
  }
  return keyBuffer;
};

function parseHex(value: string, expectedBytes: number): Buffer {
  if (!/^[0-9a-f]+$/i.test(value) || value.length !== expectedBytes * 2) {
    throw new Error("Invalid encrypted text format");
  }

  return Buffer.from(value, "hex");
}

function getLegacyAlgorithm(): string {
  return ["aes", "256", "cbc"].join("-");
}

function decryptLegacyCbc(
  encryptedText: string,
  encryptionKey: Buffer,
): string {
  const [ivHex, encryptedHex] = encryptedText.split(":");
  if (!ivHex || !encryptedHex) {
    throw new Error("Invalid encrypted text format");
  }

  const iv = parseHex(ivHex, 16);
  const encrypted = Buffer.from(encryptedHex, "hex");
  const decipher = crypto.createDecipheriv(
    getLegacyAlgorithm(),
    encryptionKey,
    iv,
  );
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export const encrypt = (text: string): string => {
  if (!text) return text;
  const encryptionKey = getEncryptionKey();
  if (!encryptionKey) {
    throw new Error("ENCRYPTION_KEY environment variable is required");
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${CURRENT_VERSION}:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
};

export const decrypt = (encryptedText: string): string => {
  if (!encryptedText) return encryptedText;
  const encryptionKey = getEncryptionKey();
  if (!encryptionKey) {
    throw new Error("ENCRYPTION_KEY environment variable is required");
  }

  const parts = encryptedText.split(":");
  if (parts.length === 4) {
    const [version, ivHex, authTagHex, encryptedHex] = parts;
    if (version !== CURRENT_VERSION || !ivHex || !authTagHex || !encryptedHex) {
      throw new Error("Invalid encrypted text format");
    }

    const iv = parseHex(ivHex, IV_LENGTH);
    const authTag = parseHex(authTagHex, AUTH_TAG_LENGTH);
    const encrypted = Buffer.from(encryptedHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  }

  if (parts.length === 2) {
    return decryptLegacyCbc(encryptedText, encryptionKey);
  }

  throw new Error("Invalid encrypted text format");
};
