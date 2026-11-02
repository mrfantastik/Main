// Telling a free, local model from one that might cost money. A model on
// this computer (or another machine on your own network) costs nothing to
// run; Claude, hosted services and Ollama's cloud models can. "Free mode"
// (LOCAL_ONLY=1, what `npm run free` sets) only ever uses the first kind.

/** A URL on this computer or the local network (so a model there runs for free). */
export function isLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".lan") ||
    host === "host.docker.internal" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host)
  );
}

/**
 * One of Ollama's cloud models ("gpt-oss:120b-cloud", "glm-4.6:cloud"): it
 * runs on ollama.com against your account's usage, even when asked for
 * through Ollama on your own computer. Not free.
 */
export function isCloudModel(name: string | undefined | null): boolean {
  return !!name && /(^|[-:])cloud\b/i.test(name);
}

/** Why this endpoint isn't free and local (null: it is). */
export function notLocal(url: string, model?: string | null): string | null {
  if (!isLocalUrl(url)) return `${url} isn't on this computer or your own network`;
  if (isCloudModel(model)) return `${model} is one of Ollama's cloud models (it runs on ollama.com and can use up paid credits)`;
  return null;
}
