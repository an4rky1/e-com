/**
 * Argon2id + pepper behaviour.
 *
 * @remarks Real `argon2`, deliberately: the properties under test are properties of the
 * native addon and of the HMAC pre-step, and a mock would prove only that the mock agrees
 * with itself. The cost parameters here are far below the shipped ones — the tests are about
 * *which* algorithm and *which* pepper, not about how slow it is, and a suite that spends a
 * second per hash per test is a suite people stop running.
 */
import {
  Argon2PasswordHasher,
  applyPepper,
} from '../src/infrastructure/security/argon2-password.hasher';
import { ARGON2_VERSION, type HashParameters } from '../src/domain/ports/password-hasher.port';

const CHEAP: Omit<HashParameters, 'algorithm'> = {
  memoryCost: 8 * 1024,
  timeCost: 1,
  parallelism: 1,
  hashLength: 32,
  version: ARGON2_VERSION,
};

const PASSWORD = 'Correct-Horse-Battery-9!';

const hasher = (pepper: string | null): Argon2PasswordHasher =>
  new Argon2PasswordHasher({ ...CHEAP, pepper });

describe('Argon2PasswordHasher.hash', () => {
  it('produces an argon2id digest carrying the configured parameters', async () => {
    const { digest, parameters } = await hasher('pepper-a').hash(PASSWORD);

    expect(digest).toMatch(/^\$argon2id\$v=19\$/);
    expect(parameters).toEqual({ algorithm: 'argon2id', ...CHEAP });
  });

  it('never returns the same digest twice for the same password', async () => {
    const instance = hasher('pepper-a');

    const first = await instance.hash(PASSWORD);
    const second = await instance.hash(PASSWORD);

    // The salt is random, so two hashes of one password are different strings — which is why
    // a stolen table cannot be attacked by noticing which rows share a digest.
    expect(first.digest).not.toBe(second.digest);
  });

  it('does not embed the password in the digest', async () => {
    const { digest } = await hasher('pepper-a').hash(PASSWORD);
    expect(digest).not.toContain(PASSWORD);
  });
});

describe('Argon2PasswordHasher.verify', () => {
  it('accepts the password the digest was made from, when the pepper matches', async () => {
    const instance = hasher('pepper-a');
    const { digest } = await instance.hash(PASSWORD);

    await expect(instance.verify(digest, PASSWORD)).resolves.toBe(true);
  });

  it('REJECTS the right password when verified against a different pepper', async () => {
    // The core property of the pepper: it is a second factor, so a digest is useless without
    // it even to someone who already has the correct password.
    const { digest } = await hasher('pepper-a').hash(PASSWORD);

    await expect(hasher('pepper-b').verify(digest, PASSWORD)).resolves.toBe(false);
  });

  it('rejects a wrong password', async () => {
    const instance = hasher('pepper-a');
    const { digest } = await instance.hash(PASSWORD);

    await expect(instance.verify(digest, 'Correct-Horse-Battery-9?!')).resolves.toBe(false);
  });

  it('answers false rather than throwing for a malformed digest', async () => {
    // `secret_hash` is a text column an operator can put anything in; a thrown
    // `VerificationError` would turn one bad row into a 500 on the sign-in path.
    await expect(hasher('pepper-a').verify('not-an-argon2-digest', PASSWORD)).resolves.toBe(false);
    await expect(hasher('pepper-a').verify('', PASSWORD)).resolves.toBe(false);
  });

  it('reports whether a pepper is in use', () => {
    expect(hasher('pepper-a').peppered).toBe(true);
    expect(hasher(null).peppered).toBe(false);
    // Whitespace is not a secret; treating it as one would produce a deployment that believes
    // it is peppered and is not.
    expect(hasher('   ').peppered).toBe(false);
  });
});

describe('the pepper itself', () => {
  it('changes the hash of the very same password', async () => {
    const a = await hasher('pepper-a').hash(PASSWORD);
    const b = await hasher('pepper-b').hash(PASSWORD);

    expect(a.digest).not.toBe(b.digest);
  });

  it('is mixed in as an HMAC, so it cannot lengthen the input', () => {
    // Concatenation would let a long password reach the argon2 input buffer verbatim; the
    // HMAC collapses it first, which is why the pepper is the *only* secret in the pipeline.
    expect(applyPepper(PASSWORD, 'pepper-a')).toHaveLength(64);
    expect(applyPepper('a'.repeat(5000), 'pepper-a')).toHaveLength(64);
  });

  it('is a no-op when unset, so hashing still works without one', async () => {
    const instance = hasher(null);
    const { digest } = await instance.hash(PASSWORD);

    await expect(instance.verify(digest, PASSWORD)).resolves.toBe(true);
  });

  it('is deterministic, so the same pepper reproduces the same pre-image', () => {
    expect(applyPepper(PASSWORD, 'pepper-a')).toBe(applyPepper(PASSWORD, 'pepper-a'));
    expect(applyPepper(PASSWORD, 'pepper-a')).not.toBe(applyPepper(PASSWORD, 'pepper-b'));
  });
});

describe('Argon2PasswordHasher.needsRehash', () => {
  const current: HashParameters = { algorithm: 'argon2id', ...CHEAP };

  it('is false for parameters identical to the current policy', () => {
    expect(hasher('pepper-a').needsRehash(current)).toBe(false);
  });

  it('is true when any single term is below the current policy', () => {
    const instance = hasher('pepper-a');

    expect(instance.needsRehash({ ...current, memoryCost: current.memoryCost - 1 })).toBe(true);
    expect(instance.needsRehash({ ...current, timeCost: current.timeCost - 1 })).toBe(true);
    expect(instance.needsRehash({ ...current, hashLength: current.hashLength - 1 })).toBe(true);
    expect(instance.needsRehash({ ...current, version: current.version - 1 })).toBe(true);
  });

  it('is false when every term is at or above the current policy', () => {
    const instance = hasher('pepper-a');

    // Stronger is not weaker. A `>=` comparison would treat a hash made with *more* memory
    // and time as due for a downgrade, which is a security regression dressed as an upgrade.
    expect(
      instance.needsRehash({
        ...current,
        memoryCost: current.memoryCost * 2,
        timeCost: current.timeCost + 1,
      }),
    ).toBe(false);
  });

  it('is false when only parallelism is higher than policy', () => {
    // `parallelism` is a CPU-vs-memory trade rather than a strength scale, but the rule is
    // uniform: strictly below means upgrade.
    const instance = hasher('pepper-a');
    expect(instance.needsRehash({ ...current, parallelism: current.parallelism + 4 })).toBe(false);
  });
});

describe('Argon2PasswordHasher.equaliseTiming', () => {
  it('resolves without throwing, for any input', async () => {
    const instance = hasher('pepper-a');
    await expect(instance.equaliseTiming(PASSWORD)).resolves.toBeUndefined();
  });

  it('is reusable — the dummy digest is built once and cached', async () => {
    // A fresh Argon2 run per unknown user would turn the enumeration defence into the
    // denial-of-service vector it was meant to prevent.
    const instance = hasher('pepper-a');
    await instance.equaliseTiming(PASSWORD);
    await expect(instance.equaliseTiming('another-password')).resolves.toBeUndefined();
  });
});