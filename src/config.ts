export interface ApikoConfig {
  /** The user's APIKO API key (`APIKO_API_KEY`). Never logged or returned by a tool. */
  apiKey: string | undefined;
  /** Data plane, `APIKO_BASE_URL` (default https://api.apiko.app). */
  baseUrl: string;
  /** Site that serves the public price catalog, `APIKO_SITE_URL` (default https://apiko.app). */
  siteUrl: string;
  /** `APIKO_MCP_READ_ONLY=1` hides the tools that spend money or publish files. */
  readOnly: boolean;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? '').trim());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApikoConfig {
  const apiKey = env.APIKO_API_KEY?.trim() || undefined;
  return {
    apiKey,
    baseUrl: trimSlash(env.APIKO_BASE_URL?.trim() || 'https://api.apiko.app'),
    siteUrl: trimSlash(env.APIKO_SITE_URL?.trim() || 'https://apiko.app'),
    readOnly: truthy(env.APIKO_MCP_READ_ONLY),
  };
}
