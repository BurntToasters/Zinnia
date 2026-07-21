interface UpdateMetainfoOptions {
  now?: Date;
  packagePath?: string;
  metadataPath?: string;
  check?: boolean;
}

interface UpdateMetainfoResult {
  updated: boolean;
  version: string;
  date: string;
}

export function formatDate(date: Date): string;
export function run(options?: UpdateMetainfoOptions): UpdateMetainfoResult;
