import argon2 from 'argon2';

export function hashPassword(plain) {
  return argon2.hash(plain, { type: argon2.argon2id });
}

/** False (never throws) for a wrong password or a malformed hash. */
export async function verifyPassword(hash, plain) {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
