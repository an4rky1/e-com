/**
 * The device fingerprint.
 *
 * @remarks No Nest container and no database: fingerprinting is a pure function of its input,
 * and the two properties that make it useful — stable for identical inputs, different for any
 * single difference — are exactly what calling it twice proves. If either ever needs a fixture
 * to be tested, it has stopped being a pure function.
 */
import {
  DeviceFingerprint,
  canonicaliseDeviceSignals,
  normaliseDeviceSignal,
  type DeviceSignals,
} from '../src/domain/value-objects/device-fingerprint.vo';

const LAPTOP: DeviceSignals = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  platform: 'macOS',
  screenResolution: '2560x1440',
  timezone: 'Europe/London',
  language: 'en-GB',
};

const PHONE: DeviceSignals = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
  platform: 'iOS',
  screenResolution: '390x844',
  timezone: 'Europe/London',
  language: 'en-GB',
};

/** Every field changed away from `LAPTOP`, one at a time. */
const SINGLE_FIELD_VARIANTS: ReadonlyArray<readonly [string, DeviceSignals]> = [
  ['userAgent', { ...LAPTOP, userAgent: `${LAPTOP.userAgent} Safari/605.1` }],
  ['platform', { ...LAPTOP, platform: 'Windows' }],
  ['screenResolution', { ...LAPTOP, screenResolution: '1920x1080' }],
  ['timezone', { ...LAPTOP, timezone: 'America/New_York' }],
  ['language', { ...LAPTOP, language: 'de-DE' }],
];

describe('DeviceFingerprint — stability', () => {
  it('is a 64-character lower-case hex digest', () => {
    const fingerprint = DeviceFingerprint.compute(LAPTOP);

    expect(fingerprint.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same value for identical inputs', () => {
    expect(DeviceFingerprint.compute(LAPTOP).value).toBe(DeviceFingerprint.compute(LAPTOP).value);
  });

  it('returns the same value across differently-ordered but identical objects', () => {
    const reordered: DeviceSignals = {
      language: LAPTOP.language,
      timezone: LAPTOP.timezone,
      screenResolution: LAPTOP.screenResolution,
      platform: LAPTOP.platform,
      userAgent: LAPTOP.userAgent,
    };

    // The hash order is a module constant, never `Object.keys` insertion order. Without that,
    // the same laptop would hash two ways depending on which caller built the object.
    expect(DeviceFingerprint.compute(reordered).value).toBe(DeviceFingerprint.compute(LAPTOP).value);
  });

  it('treats case and whitespace differences as the same device', () => {
    const shouty: DeviceSignals = {
      ...LAPTOP,
      userAgent: LAPTOP.userAgent?.toUpperCase(),
      platform: '  macOS  ',
    };

    expect(DeviceFingerprint.compute(shouty).value).toBe(DeviceFingerprint.compute(LAPTOP).value);
  });

  it('treats a missing signal and an empty one as the same device', () => {
    const sparse: DeviceSignals = { ...LAPTOP, timezone: undefined };

    expect(DeviceFingerprint.compute(sparse).value).toBe(
      DeviceFingerprint.compute({ ...LAPTOP, timezone: '' }).value,
    );
  });

  it('collapses internal whitespace rather than preserving it', () => {
    expect(normaliseDeviceSignal('  Linux;   X11  ')).toBe('linux; x11');
    expect(normaliseDeviceSignal(undefined)).toBe('');
    expect(normaliseDeviceSignal(null)).toBe('');
  });
});

describe('DeviceFingerprint — sensitivity', () => {
  it.each(SINGLE_FIELD_VARIANTS)('differs when %s changes', (_field, variant) => {
    expect(DeviceFingerprint.compute(variant).value).not.toBe(DeviceFingerprint.compute(LAPTOP).value);
  });

  it('separates two entirely different devices', () => {
    expect(DeviceFingerprint.compute(PHONE).value).not.toBe(DeviceFingerprint.compute(LAPTOP).value);
  });

  it('does not collide across the field boundary', () => {
    // Concatenation without separators would hash `{platform: 'macOS', screen: '2560x1440'}`
    // the same as `{platform: 'macOS2560x14', screen: '400'}`.
    const boundary = canonicaliseDeviceSignals({ platform: 'ab', screenResolution: 'c' });
    const shifted = canonicaliseDeviceSignals({ platform: 'a', screenResolution: 'bc' });

    expect(boundary).not.toBe(shifted);
  });
});

describe('DeviceFingerprint — rehydration', () => {
  it('normalises a supplied fingerprint so the indexed column stays comparable', () => {
    expect(DeviceFingerprint.fromValue('  ABCDEF  ').value).toBe('abcdef');
  });

  it('round-trips a stored digest unchanged', () => {
    const original = DeviceFingerprint.compute(LAPTOP);

    expect(DeviceFingerprint.fromStored(original.value).value).toBe(original.value);
  });

  it('compares by value, not by identity', () => {
    expect(DeviceFingerprint.compute(LAPTOP).equals(DeviceFingerprint.compute(LAPTOP))).toBe(true);
  });

  it('renders as its digest so it can be dropped into a string', () => {
    expect(String(DeviceFingerprint.compute(LAPTOP))).toBe(DeviceFingerprint.compute(LAPTOP).value);
  });
});