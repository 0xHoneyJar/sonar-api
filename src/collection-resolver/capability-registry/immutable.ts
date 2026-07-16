import { CapabilityRegistryMutationError } from "./errors.js";

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Deep-freeze a JSON-like value. Mutating the result throws in strict mode /
 * via the returned proxy-free frozen object.
 */
export const deepFreeze = <T>(value: T): T => {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value) as T;
  }

  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    return Object.freeze(value) as T;
  }

  return Object.freeze(value) as T;
};

/** Structured clone then freeze — returned objects are clone-safe and immutable. */
export const cloneFreeze = <T>(value: T): T => {
  const cloned = structuredClone(value);
  return deepFreeze(cloned);
};

export const assertFrozen = (value: unknown, path = "$"): void => {
  if (value === null || typeof value !== "object") return;
  if (!Object.isFrozen(value)) {
    throw new CapabilityRegistryMutationError({
      reason: `expected frozen object at ${path}`,
    });
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFrozen(item, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      assertFrozen(value[key], `${path}.${key}`);
    }
  }
};
