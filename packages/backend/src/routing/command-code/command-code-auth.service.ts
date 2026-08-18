import { Injectable, Logger } from '@nestjs/common';

/**
 * Command Code (commandcode.ai) provider auth validation.
 *
 * Command Code exposes an OpenAI/Anthropic-compatible Provider API for
 * gateways (model sync + chat), so the proxy hot path needs no custom wire
 * handling. The one CLI-ecosystem surface worth reusing is the auth check:
 * `GET /alpha/whoami` accepts a `user_...` subscription key and answers
 * whether it is valid. The models-endpoint sync would eventually fail with
 * a 401 anyway, but validating eagerly at connect time turns a silent
 * "no models synced" into an immediate, friendly setup error.
 *
 * Mirrors the headers the Command Code CLI sends (`x-command-code-version`,
 * `x-cli-environment: cli`) so the check exercises the same auth surface.
 */
@Injectable()
export class CommandCodeAuthService {
  private readonly logger = new Logger(CommandCodeAuthService.name);

  static readonly WHOAMI_URL = 'https://api.commandcode.ai/alpha/whoami';
  static readonly PROVIDER_MODELS_URL = 'https://api.commandcode.ai/provider/v1/models';
  static readonly CLI_VERSION_HEADER = '0.25.7';
  static readonly TIMEOUT_MS = 5_000;

  /**
   * Verify a Command Code API key at setup time.
   *
   * - 200: key is valid.
   * - 401/403: key is rejected — surfaced as a hard failure so the user fixes
   *   the key instead of storing a dead connection.
   * - any other status or a network error: treated as non-fatal. The connect
   *   flow must not be blocked by a transient outage or a whoami contract
   *   drift; model discovery remains the eventual source of truth.
   */
  async validateApiKey(apiKey: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const trimmed = apiKey.trim();
    if (!trimmed) return { ok: false, message: 'Command Code API key is empty' };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CommandCodeAuthService.TIMEOUT_MS);
    try {
      if (trimmed.startsWith('user_')) {
        const res = await fetch(CommandCodeAuthService.WHOAMI_URL, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${trimmed}`,
            'x-command-code-version': CommandCodeAuthService.CLI_VERSION_HEADER,
            'x-cli-environment': 'cli',
          },
          signal: controller.signal,
        });
        if (res.ok) return { ok: true };
        if (res.status === 401 || res.status === 403) {
          // Fallback check against provider models in case it's a Goat/Pro key with user_ prefix
          try {
            const providerRes = await fetch(CommandCodeAuthService.PROVIDER_MODELS_URL, {
              method: 'GET',
              headers: { Authorization: `Bearer ${trimmed}` },
              signal: controller.signal,
            });
            if (providerRes.ok) return { ok: true };
          } catch {
            // Ignore fallback error
          }
          return {
            ok: false,
            message:
              `Command Code rejected this API key (HTTP ${res.status}). Paste a valid key from ` +
              `~/.commandcode/auth.json (Go plan: "user_...") or your Command Code account (Goat/Pro plans).`,
          };
        }
        this.logger.warn(`commandcode whoami returned HTTP ${res.status}; treating as non-fatal`);
        return { ok: true };
      }

      // Non-user_ key: Goat or Pro plan API key
      const res = await fetch(CommandCodeAuthService.PROVIDER_MODELS_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${trimmed}` },
        signal: controller.signal,
      });
      if (res.ok) return { ok: true };
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          message: `Command Code rejected this API key (HTTP ${res.status}). Ensure your Goat or Pro plan API key is active.`,
        };
      }
      this.logger.warn(`commandcode models returned HTTP ${res.status}; treating as non-fatal`);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`commandcode auth check failed (${message}); treating as non-fatal`);
      return { ok: true };
    } finally {
      clearTimeout(timeout);
    }
  }
}
