export function githubAuthorizationForUrl(url, token) {
  if (!token) return undefined;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  return parsed.protocol === "https:" &&
    parsed.hostname.toLowerCase() === "github.com"
    ? `Bearer ${token}`
    : undefined;
}
