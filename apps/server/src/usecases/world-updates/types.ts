export type WorldReleaseRecord = {
  version: string;
  title?: string;
  published_at: string;
  notes: string;
  spec_version: string;
  artifact: {
    format: 'zip' | 'json';
    url: string;
    sha256: string;
    size_bytes: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type WorldVersionIndex = {
  schema_version: 1;
  package_id: string;
  versions: WorldReleaseRecord[];
  [key: string]: unknown;
};

export type WorldUpdateStatus = 'no_source' | 'not_checked' | 'checking' | 'ready' | 'failed';
export type WorldVersionSummary = {
  currentVersion: string | null;
  latestVersion: string | null;
  updateStatus: WorldUpdateStatus;
};
export type WorldVersions = WorldVersionSummary & {
  worldId: string;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  errorCode: string | null;
  versions: (WorldReleaseRecord & { supported: boolean })[];
};
export type ApplyWorldVersionInput = {
  version: string;
  expectedSha256: string;
  expectedRevision: number;
};
export type WorldUpdateSource = { worldId: string; packageId: string; updateUrl: string };
export type CheckRecord = { lastAttemptAt: number; errorCode: string | null };
export type CheckTask = { source: WorldUpdateSource; controller: AbortController; promise: Promise<WorldVersions> };
