import { HttpException, HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { IncomingHttpHeaders } from 'http';
import { Repository } from 'typeorm';
import { v4 as uuid } from 'uuid';
import {
  DEFAULT_OUTPUT_MODALITY,
  FAILED_STATUS,
  SUCCESS_STATUS,
  type AuthType,
  type ModelRoute,
  type OutputModality,
} from 'manifest-shared';
import { AgentMessage } from '../../entities/agent-message.entity';
import { ManifestRequest } from '../../entities/request.entity';
import { ModelDiscoveryService } from '../../model-discovery/model-discovery.service';
import { PlanService } from '../../billing/plan.service';
import { formatManifestError, type ManifestErrorCode } from '../../common/errors/error-codes';
import {
  MANIFEST_CODE_TO_REASON,
  ManifestError,
  isRecordableManifestCode,
} from '../../common/errors/manifest-error';
import type { IngestionContext } from '../../otlp/interfaces/ingestion-context.interface';
import { ResolveService } from '../resolve/resolve.service';
import { ProviderKeyService } from '../routing-core/provider-key.service';
import { OpenaiOauthService } from '../oauth/openai/openai-oauth.service';
import { MinimaxOauthService } from '../oauth/minimax/minimax-oauth.service';
import { AnthropicOauthService } from '../oauth/anthropic/anthropic-oauth.service';
import { GeminiOauthService } from '../oauth/gemini/gemini-oauth.service';
import { KiroOauthService } from '../oauth/kiro/kiro-oauth.service';
import { XaiOauthService } from '../oauth/xai/xai-oauth.service';
import { classifyCaller, type CallerAttribution } from '../proxy/caller-classifier';
import { ProxyMessageRecorder } from '../proxy/proxy-message-recorder';
import { ProxyRateLimiter } from '../proxy/proxy-rate-limiter';
import { sanitizeRequestHeaders } from '../proxy/request-headers';
import { resolveRouteCredentials } from '../proxy/route-credentials';
import { routeForOpenAiModelId } from '../proxy/openai-model-id';
import type { ProviderAttemptRef, ProviderAttemptStart } from '../proxy/proxy-types';
import { MediaProviderClient, type MediaApiMode } from './media-provider-client';
import { normalizeMediaBody } from './media-request-body';
import { validateMediaRequest } from './media-validation';
import { imageCostUsd, videoCostUsd } from './media-pricing';
import type { ResolveResponse } from '../dto/resolve-response';

const MODEL_UNAVAILABLE: ManifestErrorCode = 'M302';

export interface MediaCallInput {
  ctx: IngestionContext;
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
  apiMode: MediaApiMode;
  /** Caller IP for the per-IP rate limit. */
  ip?: string;
  signal?: AbortSignal;
}

export interface MediaCallResult {
  status: number;
  body: unknown;
  /**
   * The concrete route the request resolved to. A synthetic `auto-{tier}`
   * request picks a real provider/model at request time; callers (the
   * Playground) surface this so the operator sees which model served it.
   * Absent when resolution failed before a route was chosen.
   */
  resolvedRoute?: MediaResolvedRoute | null;
  /**
   * Cost in USD the run was billed. Null for an asynchronous video create
   * (unknown until the task completes) and when pricing is unknown.
   */
  costUsd?: number | null;
}

/** The concrete provider/model a media request resolved to. */
export interface MediaResolvedRoute {
  provider: string;
  model: string;
  tier: string;
  reason: string;
  headerTierName?: string;
  headerTierColor?: string;
}

interface ResolvedMediaRoute {
  route: ModelRoute;
  /** The modality the caller's endpoint expects. */
  expected: 'image' | 'video';
  /** The modality the resolved model actually produces. */
  actual: OutputModality;
  tier: string;
  reason: string;
  headerTierId?: string;
  headerTierName?: string;
  headerTierColor?: string;
}

/**
 * Serves image and video generation through Manifest's routing.
 *
 * The flow mirrors the text proxy: a Manifest Request is recorded at ingress,
 * the route is resolved (header tier → `auto-{name}` tier → direct model),
 * credentials come from the same per-tenant provider keys, one Provider
 * Attempt is recorded per upstream call, and cost lands in `agent_messages`.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly resolveService: ResolveService,
    private readonly providerKeyService: ProviderKeyService,
    private readonly modelDiscovery: ModelDiscoveryService,
    private readonly mediaClient: MediaProviderClient,
    private readonly recorder: ProxyMessageRecorder,
    private readonly rateLimiter: ProxyRateLimiter,
    private readonly planService: PlanService,
    private readonly openaiOauth: OpenaiOauthService,
    private readonly minimaxOauth: MinimaxOauthService,
    private readonly anthropicOauth: AnthropicOauthService,
    private readonly geminiOauth: GeminiOauthService,
    private readonly kiroOauth: KiroOauthService,
    private readonly xaiOauth: XaiOauthService,
    @InjectRepository(ManifestRequest)
    private readonly requestRepo: Repository<ManifestRequest>,
    @InjectRepository(AgentMessage)
    private readonly messageRepo: Repository<AgentMessage>,
  ) {}

  async handle(input: MediaCallInput): Promise<MediaCallResult> {
    const { ctx, headers, apiMode, signal, ip } = input;
    // Accept the provider-native `extra_body` wrapper as well as the
    // OpenAI-shaped top level, once, before validation or forwarding. Every
    // downstream reader (validation, translation, cost) then sees one shape.
    const body = normalizeMediaBody(input.body);
    const requestId = uuid();
    const traceId = extractTraceId(headers);
    const callerAttribution = classifyCaller(headers);
    const requestHeaders = sanitizeRequestHeaders(headers);
    const sessionKey = extractSessionKey(headers);
    const startedAt = Date.now();

    await this.recorder
      .recordPendingRequest(ctx, {
        requestId,
        timestamp: new Date(startedAt).toISOString(),
        traceId,
        sessionKey,
        requestedModel: requestedModelOf(body),
        callerAttribution,
        requestHeaders,
        apiMode,
      })
      .catch((e) => this.logger.warn(`Failed to record pending media Request: ${e}`));

    const expected: 'image' | 'video' = apiMode === 'images' ? 'image' : 'video';

    let slotAcquired = false;
    try {
      await this.planService.assertWithinRequestLimit(ctx);
      this.rateLimiter.checkLimit(ctx.tenantId);
      this.rateLimiter.checkIpLimit(ip ?? '');
      this.rateLimiter.acquireSlot(ctx.tenantId);
      slotAcquired = true;
    } catch (err) {
      return this.recordManifestFailure(err, {
        ctx,
        requestId,
        traceId,
        callerAttribution,
        requestHeaders,
        apiMode,
        startedAt,
      });
    }

    try {
      const resolved = await this.resolveRoute(ctx, body, headers, expected);
      if (!resolved) {
        return this.recordManifestFailure(
          new ManifestError(MODEL_UNAVAILABLE, HttpStatus.BAD_REQUEST, {
            model: requestedModelOf(body) ?? 'auto',
            dashboardUrl: 'the dashboard',
          }),
          { ctx, requestId, traceId, callerAttribution, requestHeaders, apiMode, startedAt },
        );
      }

      const { route } = resolved;

      // Modality gate: an image endpoint cannot serve a video model and vice
      // versa. Checked before any credential or provider work.
      if (resolved.actual !== resolved.expected) {
        return this.recordManifestFailure(
          new ManifestError('M301', HttpStatus.BAD_REQUEST, {
            expected: resolved.expected,
            actual: resolved.actual,
            model: route.model,
          }),
          { ctx, requestId, traceId, callerAttribution, requestHeaders, apiMode, startedAt },
        );
      }
      // Request-shape validation before any credential or provider work: a
      // malformed media body becomes a documented M304 instead of a provider
      // 400 that would count against the provider's reliability.
      const invalidReason = validateMediaRequest({
        provider: route.provider,
        apiMode,
        body,
      });
      if (invalidReason) {
        return this.recordManifestFailure(
          new ManifestError('M304', HttpStatus.BAD_REQUEST, {
            modality: expected,
            reason: invalidReason,
          }),
          { ctx, requestId, traceId, callerAttribution, requestHeaders, apiMode, startedAt },
        );
      }

      const credentials = await resolveRouteCredentials(this.credentialDeps(), {
        agentId: ctx.agentId,
        tenantId: ctx.tenantId,
        provider: route.provider,
        authType: route.authType,
        providerKeyLabel: route.keyLabel ?? undefined,
      });
      if (!credentials.ok) {
        return this.recordManifestFailure(
          new ManifestError(
            credentials.reason === 'no_provider_key' ? 'M100' : 'M102',
            HttpStatus.UNAUTHORIZED,
            { provider: route.provider, dashboardUrl: 'the dashboard' },
          ),
          { ctx, requestId, traceId, callerAttribution, requestHeaders, apiMode, startedAt },
        );
      }

      const attempt = this.startAttempt(
        ctx,
        requestId,
        {
          provider: route.provider,
          model: route.model,
          authType: route.authType,
          tenantProviderId: credentials.tenantProviderId,
          keyLabel: credentials.keyLabel,
        },
        apiMode,
      );

      const forward = await this.mediaClient.forward({
        provider: route.provider,
        apiKey: credentials.apiKey,
        model: route.model,
        apiMode,
        body,
        signal,
      });

      if (!forward.ok) {
        attempt.completeFailure?.({
          status: forward.status,
          errorBody: stringifyError(forward.body),
          superseded: false,
        });
        await this.recorder
          .recordProviderError(ctx, forward.status, stringifyError(forward.body), {
            requestId,
            attempt,
            attemptNumber: attempt.attemptNumber,
            model: route.model,
            provider: route.provider,
            tier: resolved.tier,
            reason: resolved.reason,
            authType: route.authType,
            providerKeyLabel: credentials.keyLabel,
            tenantProviderId: credentials.tenantProviderId,
            callerAttribution,
            requestHeaders,
            requestDurationMs: Date.now() - startedAt,
            apiMode,
            headerTierId: resolved.headerTierId,
            headerTierName: resolved.headerTierName,
            headerTierColor: resolved.headerTierColor,
          })
          .catch((e) => this.logger.warn(`Failed to record media provider error: ${e}`));
        return { status: forward.status, body: errorEnvelope(forward.status, forward.body) };
      }

      const isVideo = apiMode === 'videos';
      const imageCount = isVideo ? 0 : countImages(forward.body);
      const size = typeof body.size === 'string' ? body.size : undefined;
      const costUsd = isVideo
        ? videoCostUsd(route.provider, route.model, forward.seconds ?? 0, size)
        : imageCostUsd(route.provider, route.model, imageCount, size);

      await this.recorder
        .recordSuccessMessage(
          ctx,
          route.model,
          resolved.tier,
          resolved.reason,
          { prompt_tokens: 0, completion_tokens: 0 },
          {
            requestId,
            attempt,
            attemptNumber: attempt.attemptNumber,
            traceId,
            provider: route.provider,
            authType: route.authType,
            sessionKey,
            durationMs: Date.now() - startedAt,
            providerKeyLabel: credentials.keyLabel,
            tenantProviderId: credentials.tenantProviderId,
            callerAttribution,
            requestHeaders,
            apiMode,
            headerTierId: resolved.headerTierId,
            headerTierName: resolved.headerTierName,
            headerTierColor: resolved.headerTierColor,
            // Video cost is only known once the task completes; record null
            // now and let the status endpoint fill it in.
            costUsdOverride: isVideo ? null : costUsd,
          },
        )
        .catch((e) => this.logger.warn(`Failed to record media success: ${e}`));

      if (isVideo && forward.taskId) {
        await this.attachVideoTask(requestId, forward.taskId, {
          seconds: requestedSeconds(body),
          size,
        }).catch((e) => this.logger.warn(`Failed to attach media task id: ${e}`));
      }

      return {
        status: forward.status,
        body: forward.body,
        resolvedRoute: this.toResolvedRoute(resolved),
        costUsd: isVideo ? null : costUsd,
      };
    } catch (err) {
      return this.recordManifestFailure(err, {
        ctx,
        requestId,
        traceId,
        callerAttribution,
        requestHeaders,
        apiMode,
        startedAt,
      });
    } finally {
      if (slotAcquired) this.rateLimiter.releaseSlot(ctx.tenantId);
    }
  }

  /** Poll an asynchronous video task and finalize its cost on completion. */
  async videoStatus(
    ctx: IngestionContext,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<MediaCallResult> {
    const request = await this.requestRepo.findOne({
      where: { tenant_id: ctx.tenantId, media_task_id: taskId },
    });
    if (!request || request.agent_id !== ctx.agentId) {
      return {
        status: 404,
        body: {
          error: { message: `Video task "${taskId}" not found`, type: 'invalid_request_error' },
        },
      };
    }

    const attempt = await this.messageRepo.findOne({
      where: { request_id: request.id },
      order: { attempt_number: 'DESC' },
    });
    if (!attempt?.provider || !attempt.model) {
      return {
        status: 409,
        body: {
          error: { message: 'Video task has no recorded provider attempt', type: 'server_error' },
        },
      };
    }

    const credentials = await resolveRouteCredentials(this.credentialDeps(), {
      agentId: ctx.agentId,
      tenantId: ctx.tenantId,
      provider: attempt.provider,
      authType: (attempt.auth_type as AuthType | null) ?? undefined,
      providerKeyLabel: attempt.provider_key_label ?? undefined,
    });
    if (!credentials.ok) {
      return {
        status: 401,
        body: {
          error: {
            message: 'Provider credentials for this task are unavailable',
            type: 'invalid_request_error',
          },
        },
      };
    }

    const status = await this.mediaClient.videoStatus({
      provider: attempt.provider,
      apiKey: credentials.apiKey,
      model: attempt.model,
      taskId,
      signal,
    });

    if (status.ok) {
      const seconds = status.seconds ?? requestSeconds(request);
      const costUsd = videoCostUsd(
        attempt.provider,
        attempt.model,
        seconds ?? 0,
        requestSize(request),
      );
      await this.finalizeVideoTask(
        request.id,
        attempt.id,
        status.videoStatus ?? 'queued',
        costUsd,
      ).catch((e) => this.logger.warn(`Failed to finalize video task: ${e}`));
      return { status: status.status, body: status.body, costUsd };
    }

    return { status: status.status, body: status.body };
  }

  /* ── Resolution ─────────────────────────────────────────────────── */

  private toResolvedRoute(resolved: ResolvedMediaRoute): MediaResolvedRoute {
    return {
      provider: resolved.route.provider,
      model: resolved.route.model,
      tier: resolved.tier,
      reason: resolved.reason,
      ...(resolved.headerTierName ? { headerTierName: resolved.headerTierName } : {}),
      ...(resolved.headerTierColor ? { headerTierColor: resolved.headerTierColor } : {}),
    };
  }

  private async resolveRoute(
    ctx: IngestionContext,
    body: Record<string, unknown>,
    headers: IncomingHttpHeaders,
    expected: 'image' | 'video',
  ): Promise<ResolvedMediaRoute | null> {
    const requested = requestedModelOf(body);
    let resolved: ResolveResponse | null = null;
    let tier = 'direct';
    let reason = 'direct';

    if (requested && /^auto-(.+)$/i.test(requested)) {
      resolved = await this.resolveService.resolveAutoTierModel(
        ctx.agentId,
        ctx.tenantId,
        requested,
      );
      if (resolved) {
        tier = resolved.tier;
        reason = resolved.reason;
      }
    }
    if (!resolved) {
      const headerMatch = await this.resolveService.resolveHeaderTier(
        ctx.agentId,
        ctx.tenantId,
        headers,
      );
      if (headerMatch) {
        resolved = headerMatch;
        tier = headerMatch.tier;
        reason = headerMatch.reason;
      }
    }
    if (!resolved && requested) {
      resolved = await this.resolveDirect(ctx, requested);
      if (resolved) {
        tier = 'direct';
        reason = 'direct';
      }
    }
    if (!resolved?.route) return null;

    const route = resolved.route;
    const actual = await this.modelOutputModality(
      ctx,
      route.provider,
      route.model,
      resolved.output_modality,
    );
    const headerTier = resolved.header_tier_id
      ? {
          headerTierId: resolved.header_tier_id,
          headerTierName: resolved.header_tier_name,
          headerTierColor: resolved.header_tier_color,
        }
      : {};

    return { route, expected, actual, tier, reason, ...headerTier };
  }

  private async resolveDirect(
    ctx: IngestionContext,
    model: string,
  ): Promise<ResolveResponse | null> {
    const discovered = await this.modelDiscovery.getModelsForAgent(ctx.tenantId, ctx.agentId);
    // Resolve the published id exactly like the chat proxy does. Matching the
    // raw string against `cached_models` missed the provider-qualified id that
    // `/v1/models` publishes (`agnes/agnes-image-2.1-flash`), so a client that
    // copied the listed id got M302 while the same id worked on
    // /v1/chat/completions.
    const route = routeForOpenAiModelId(model, discovered);
    if (!route) return null;
    const match =
      discovered.find(
        (m) => m.id === route.model && m.provider.toLowerCase() === route.provider.toLowerCase(),
      ) ?? discovered.find((m) => m.id === route.model);
    const outputModality = modalityOfModel(match?.outputModalities) ?? DEFAULT_OUTPUT_MODALITY;
    return {
      tier: 'default',
      route,
      fallback_routes: null,
      output_modality: outputModality,
      response_mode: 'buffered',
      confidence: 1,
      score: 0,
      reason: 'default',
    };
  }

  /**
   * The modality a route really produces. A media tier's configured modality
   * wins; otherwise the discovered model's output modality decides. This is
   * what enforces the endpoint gate: an image model cannot serve /v1/videos.
   */
  private async modelOutputModality(
    ctx: IngestionContext,
    provider: string,
    model: string,
    tierModality: OutputModality | undefined,
  ): Promise<OutputModality> {
    if (tierModality === 'image' || tierModality === 'video') return tierModality;
    const discovered = await this.modelDiscovery.getModelsForAgent(ctx.tenantId, ctx.agentId);
    const match =
      discovered.find(
        (m) => m.id === model && m.provider.toLowerCase() === provider.toLowerCase(),
      ) ?? discovered.find((m) => m.id === model);
    return modalityOfModel(match?.outputModalities) ?? DEFAULT_OUTPUT_MODALITY;
  }

  /* ── Attempts ───────────────────────────────────────────────────── */

  private startAttempt(
    ctx: IngestionContext,
    requestId: string,
    start: ProviderAttemptStart,
    apiMode: MediaApiMode,
  ): ProviderAttemptRef {
    const startedAtMs = Date.now();
    const attempt: ProviderAttemptRef = {
      id: uuid(),
      attemptNumber: 1,
      startedAtMs,
      startedAt: new Date(startedAtMs).toISOString(),
      pendingWrite: Promise.resolve(false),
    };
    attempt.pendingWrite = this.recorder
      .recordPendingProviderAttempt(ctx, requestId, attempt, start)
      .catch((e) => {
        this.logger.warn(`Failed to record pending media Attempt: ${e}`);
        return false;
      });
    attempt.completeFailure = ({ status, errorBody, superseded }) =>
      this.recorder
        .completePendingProviderFailure(attempt, status, errorBody, superseded)
        .catch((e) => this.logger.warn(`Failed to complete media Attempt: ${e}`));
    void apiMode;
    return attempt;
  }

  /* ── Video task persistence ─────────────────────────────────────── */

  private async attachVideoTask(
    requestId: string,
    taskId: string,
    params: { seconds?: number; size?: string },
  ): Promise<void> {
    await this.requestRepo.update(
      { id: requestId },
      {
        media_task_id: taskId,
        ...(params.seconds !== undefined || params.size !== undefined
          ? {
              request_params: {
                ...(params.seconds !== undefined ? { seconds: params.seconds } : {}),
                ...(params.size !== undefined ? { size: params.size } : {}),
              },
            }
          : {}),
      },
    );
  }

  private async finalizeVideoTask(
    requestId: string,
    attemptId: string,
    status: string,
    costUsd: number | null,
  ): Promise<void> {
    // Only a terminal task changes the outcome. A still-running task keeps the
    // success the create recorded and just gains the (partial) cost so far.
    // The provider's vocabulary ('completed' / 'failed') must be mapped onto
    // the canonical status: `normalizeStatus` treats an unknown value as failed.
    if (status === 'completed' || status === 'failed') {
      const canonical = status === 'failed' ? FAILED_STATUS : SUCCESS_STATUS;
      await this.messageRepo.update({ id: attemptId }, { cost_usd: costUsd, status: canonical });
      await this.requestRepo.update({ id: requestId }, { status: canonical });
      return;
    }
    await this.messageRepo.update({ id: attemptId }, { cost_usd: costUsd });
  }

  /* ── Failures ───────────────────────────────────────────────────── */

  private async recordManifestFailure(
    err: unknown,
    info: {
      ctx: IngestionContext;
      requestId: string;
      traceId?: string;
      callerAttribution: CallerAttribution | null;
      requestHeaders: Record<string, string> | null;
      apiMode: MediaApiMode;
      startedAt: number;
    },
  ): Promise<MediaCallResult> {
    const status =
      err instanceof HttpException ? err.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const code: ManifestErrorCode = err instanceof ManifestError ? err.code : 'M500';
    // A ManifestError already carries its interpolated message; only a
    // non-Manifest throw needs the bare catalogue text.
    const message = err instanceof ManifestError ? err.message : formatManifestError(code);
    this.logger.warn(`Media request blocked: ${code} status=${status}`);

    if (isRecordableManifestCode(code)) {
      await this.recorder
        .recordManifestBlockedRequest(info.ctx, {
          requestId: info.requestId,
          httpStatus: status,
          errorMessage: message,
          errorCode: code,
          reason: MANIFEST_CODE_TO_REASON[code],
          traceId: info.traceId,
          callerAttribution: info.callerAttribution,
          requestHeaders: info.requestHeaders,
          durationMs: Date.now() - info.startedAt,
          apiMode: info.apiMode,
        })
        .catch((e) => this.logger.warn(`Failed to record blocked media request: ${e}`));
    }

    return { status, body: { error: { message, type: errorTypeForStatus(status) } } };
  }

  private credentialDeps() {
    return {
      providerKeyService: this.providerKeyService,
      oauth: {
        openaiOauth: this.openaiOauth,
        minimaxOauth: this.minimaxOauth,
        anthropicOauth: this.anthropicOauth,
        geminiOauth: this.geminiOauth,
        kiroOauth: this.kiroOauth,
        xaiOauth: this.xaiOauth,
      },
    };
  }
}

/* ── Helpers ──────────────────────────────────────────────────────── */

function requestedModelOf(body: Record<string, unknown>): string | undefined {
  const model = body.model;
  return typeof model === 'string' && model.length > 0 ? model : undefined;
}

function modalityOfModel(modalities: readonly string[] | undefined): OutputModality | undefined {
  if (!modalities) return undefined;
  if (modalities.includes('image')) return 'image';
  if (modalities.includes('video')) return 'video';
  return 'text';
}

function countImages(body: unknown): number {
  const data = (body as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data.length : 0;
}

function requestedSeconds(body: Record<string, unknown>): number | undefined {
  const raw = body.seconds;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function requestSeconds(request: ManifestRequest): number | undefined {
  const params = request.request_params as Record<string, unknown> | null | undefined;
  const raw = params?.['seconds'];
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  return undefined;
}

function requestSize(request: ManifestRequest): string | undefined {
  const params = request.request_params as Record<string, unknown> | null | undefined;
  const raw = params?.['size'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function errorTypeForStatus(status: number): string {
  if (status >= 500) return 'server_error';
  if (status === 404) return 'invalid_request_error';
  return 'invalid_request_error';
}

function errorEnvelope(status: number, body: unknown): unknown {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
  if (record && typeof record.error === 'object' && record.error !== null) return body;
  const message =
    record && typeof record.error === 'string'
      ? record.error
      : typeof body === 'string' && body.length > 0
        ? body
        : 'Media provider request failed';
  return { error: { message, type: errorTypeForStatus(status) } };
}

function stringifyError(body: unknown): string {
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function extractTraceId(headers: IncomingHttpHeaders): string | undefined {
  const header = headers['traceparent'];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return undefined;
  const parts = value.split('-');
  return parts.length >= 2 ? parts[1] : undefined;
}

function extractSessionKey(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers['x-session-key'] ?? headers['x-opencode-session'] ?? headers['x-session-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
