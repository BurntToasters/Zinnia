export type UpdaterChannelVariant = {
  targetSuffix: string;
  baseUrl: string;
};

export function isChecksumTextName(name: string): boolean;
export function isDirectExecution(): boolean;
export function requiredLinuxTargetKeys(
  channelVariants: UpdaterChannelVariant[],
  byName: Map<string, string>,
): Set<string>;
