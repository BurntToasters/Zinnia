export const UPDATE_FORMATS: string[];
export const APP_EXTRACT_SWITCHES: string[];
export const APP_LIST_SWITCHES: string[];
export const APP_TEST_SWITCHES: string[];
export const APP_UPDATE_SWITCHES: string[];
export const APP_CREATE_PREFIX: string[];
export function parseSltMemberPaths(stdout: string): string[];
export function listingHasMember(stdout: string, memberPath: string): boolean;
export function hardenFixture7zArgs(
  args: string[],
  platform?: NodeJS.Platform,
): string[];
