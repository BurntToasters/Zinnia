export function binaryContainsUtf8String(
  binary: string | Buffer,
  needle: string,
): boolean;
export function isFatMachO(buffer: Buffer): boolean;
export function listMachOArchitectures(binaryPath: string): string[];
export function assertBinaryContainsAppGroup(
  binary: string | Buffer,
  expectedGroup: string,
  label?: string,
): void;
export function assertUniversalBinaryContainsAppGroup(
  binaryPath: string,
  expectedGroup: string,
  label?: string,
): void;
