/**
 * Endpoints derived from the origin this dashboard is served from.
 *
 * The dashboard and the API ship as one service, so the browser's own origin is
 * the install's origin. No backend round-trip is needed and the result is right
 * on Cloud and self-hosted alike, which is exactly the part the documentation
 * cannot know. The existing setup snippets already build
 * `${window.location.origin}/v1` the same way.
 *
 * Under the Vite dev server the dashboard runs on its own port, so these read as
 * the dev server's origin rather than the backend's. That is a dev-only artifact
 * and matches the behaviour of the snippets mentioned above.
 */
export function installOrigin(): string {
  return window.location.origin;
}

/** Where an MCP client should be pointed. */
export function mcpEndpoint(): string {
  return `${installOrigin()}/api/v1/mcp`;
}
