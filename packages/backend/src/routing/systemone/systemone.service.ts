import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ProviderKeyService } from '../routing-core/provider-key.service';
import {
  CLASSIFIER_MODELS,
  CLASSIFIER_PROVIDER,
  OPENCODE_ZEN_SYSTEMONE_URL,
  SYSTEMONE_TIMEOUT_MS,
  normalizeClassifierModelId,
} from './systemone.constants';

export interface SystemOneRequest {
  tenantId: string;
  agentId: string;
  /** Raw client body. Forwarded with only `model` normalized. */
  body: Record<string, unknown>;
  /** Aborts the upstream call when the client disconnects. */
  signal?: AbortSignal;
}

export interface SystemOneResult {
  /** Upstream HTTP status, passed through so the client sees real errors. */
  status: number;
  body: unknown;
  /** `true` when `body` is raw text rather than parsed JSON. */
  raw?: boolean;
}

/**
 * Proxies Manifest's classifier route to OpenCode Zen's System One endpoint.
 *
 * Credential resolution reuses the OpenCode Zen chat credential already stored
 * for the tenant — the classifier route introduces no new secret. The request
 * and response bodies are passed through unchanged so `usage.input_tokens` /
 * `usage.output_tokens` reach the client intact.
 */
@Injectable()
export class SystemOneService {
  private readonly logger = new Logger(SystemOneService.name);

  constructor(private readonly providerKeys: ProviderKeyService) {}

  async classify(request: SystemOneRequest): Promise<SystemOneResult> {
    const rawModel = request.body['model'];
    const model = normalizeClassifierModelId(typeof rawModel === 'string' ? rawModel : null);
    if (!model) {
      throw new HttpException(
        {
          error: {
            message:
              `Unknown classifier model "${typeof rawModel === 'string' ? rawModel : ''}". ` +
              `Available classifier models: ${CLASSIFIER_MODELS.map((entry) => entry.id).join(', ')}.`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        },
        404,
      );
    }

    const credential = await this.providerKeys.selectProviderKey(
      request.tenantId,
      CLASSIFIER_PROVIDER,
      'api_key',
      undefined,
      request.agentId,
    );
    const apiKey = credential?.apiKey;
    if (!apiKey) {
      throw new HttpException(
        {
          error: {
            message:
              `No ${CLASSIFIER_PROVIDER} credential is connected for this agent, so ` +
              'classifier models are unavailable. Connect OpenCode Zen in the dashboard first.',
            type: 'invalid_request_error',
            code: 'provider_not_connected',
          },
        },
        400,
      );
    }

    return this.forward(apiKey, { ...request.body, model }, request.signal);
  }

  private async forward(
    apiKey: string,
    payload: Record<string, unknown>,
    clientSignal?: AbortSignal,
  ): Promise<SystemOneResult> {
    const timeout = AbortSignal.timeout(SYSTEMONE_TIMEOUT_MS);
    const signal = clientSignal ? AbortSignal.any([clientSignal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(OPENCODE_ZEN_SYSTEMONE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (clientSignal?.aborted) {
        // The client went away; nobody is listening for this response.
        throw new HttpException({ error: { message: 'Client closed request' } }, 499);
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`System One upstream request failed: ${detail}`);
      throw new HttpException(
        {
          error: {
            message: `System One upstream request failed: ${detail}`,
            type: 'api_error',
          },
        },
        502,
      );
    }

    const text = await response.text();
    if (text.length === 0) return { status: response.status, body: null };

    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: response.status, body: text, raw: true };
    }
  }
}
