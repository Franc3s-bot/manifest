/** Keep in sync with package.json — checked by version.spec.ts. */
export const VERSION = '0.1.0';

/**
 * The one User-Agent every CLI-originated HTTP request carries — management
 * API and gateway alike — so the server's caller attribution sees one client.
 */
export const CLI_USER_AGENT = `mnfst-cli/${VERSION}`;
