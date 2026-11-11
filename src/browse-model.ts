export interface BrowseEntry {
  path: string;
  size: number;
  packedSize: number;
  modified: string;
  isFolder: boolean;
}

export interface ArchiveInfo {
  type: string;
  physicalSize: number;
  method: string;
  solid: boolean;
  encrypted: boolean;
  /** True when any member uses ZipCrypto. 7-Zip reports it per member only. */
  zipCrypto?: boolean;
  entries: BrowseEntry[];
}
