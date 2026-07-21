export interface ReleaseCiRun {
  name?: string;
  event?: string;
  head_branch?: string;
  head_sha?: string;
  status?: string;
  conclusion?: string;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
}

export function expectedReleaseBranch(version: string): "beta" | "main";

export function selectLatestCiRun(
  runs: ReleaseCiRun[],
  options: { branch: string; sha: string },
): ReleaseCiRun | undefined;
