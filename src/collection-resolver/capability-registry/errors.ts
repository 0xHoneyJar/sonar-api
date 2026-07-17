import { Data } from "effect";

export class CapabilityRegistryDecodeError extends Data.TaggedError(
  "CapabilityRegistryDecodeError",
)<{
  readonly reason: string;
  readonly cause: unknown;
}> {}

export class CapabilityRegistryValidationError extends Data.TaggedError(
  "CapabilityRegistryValidationError",
)<{
  readonly reason: string;
  readonly path: string;
}> {}

export class CapabilityRegistryTransitionError extends Data.TaggedError(
  "CapabilityRegistryTransitionError",
)<{
  readonly reason: string;
  readonly path: string;
}> {}

export class CapabilityRegistrySignatureError extends Data.TaggedError(
  "CapabilityRegistrySignatureError",
)<{
  readonly reason: string;
}> {}

export class CapabilityRegistryMutationError extends Data.TaggedError(
  "CapabilityRegistryMutationError",
)<{
  readonly reason: string;
}> {}

export type CapabilityRegistryError =
  | CapabilityRegistryDecodeError
  | CapabilityRegistryValidationError
  | CapabilityRegistryTransitionError
  | CapabilityRegistrySignatureError
  | CapabilityRegistryMutationError;
