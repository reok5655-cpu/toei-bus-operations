import "server-only";

/** Add the ODPT consumer key server-side, replacing a catalog placeholder if present. */
export function odptUrlWithKey(endpoint: string, key: string): string {
  const url = new URL(endpoint);
  url.searchParams.set("acl:consumerKey", key);
  return url.toString();
}
