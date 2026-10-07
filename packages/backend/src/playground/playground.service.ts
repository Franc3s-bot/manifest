import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuid } from 'uuid';
import type { Response as ExpressResponse } from 'express';
import type {
  AuthType,
  PlaygroundImageOutput,
  PlaygroundMediaOutput,
  PlaygroundMetrics,
  PlaygroundOutputKind,
  PlaygroundResolvedRoute,
  PlaygroundStreamEvent,
  PlaygroundVideoOutput,
  VideoStatus,
} from 'manifest-shared';
import { AgentMessage } from '../entities/agent-message.entity';
import { CustomProvider } from '../entities/custom-provider.entity';
import { ProviderClient } from '../routing/proxy/provider-client';
import { resolveForwardEndpoint } from '../routing/proxy/forward-endpoint-resolver';
import { CustomProviderService } from '../routing/custom-provider/custom-provider.service';
import {
  isRefreshableOAuthCredential,
  refreshRejectedOAuthCredential,
  resolveApiKey,
} from '../routing/proxy/oauth-credentials';
import { ProviderKeyService } from '../routing/routing-core/provider-key.service';
import { isLocalOnlyProvider } from '../common/utils/provider-availability';
import { OpencodeGoCatalogService } from '../model-discovery/opencode-go-catalog.service';
import { ModelDiscoveryService } from '../model-discovery/model-discovery.service';
import { PROVIDER_BY_ID_OR_ALIAS } from '../common/constants/providers';
import { PlaygroundAgentService } from './playground-agent.service';
import { OpenaiOauthService } from '../routing/oauth/openai/openai-oauth.service';
import { MinimaxOauthService } from '../routing/oauth/minimax/minimax-oauth.service';
import { AnthropicOauthService } from '../routing/oauth/anthropic/anthropic-oauth.service';
import { GeminiOauthService } from '../routing/oauth/gemini/gemini-oauth.service';
import { KiroOauthService } from '../routing/oauth/kiro/kiro-oauth.service';
import { XaiOauthService } from '../routing/oauth/xai/xai-oauth.service';
import { ModelPricingCacheService } from '../model-prices/model-pricing-cache.service';
import { computeTokenCost } from '../common/utils/cost-calculator';
import { scrubSecrets } from '../common/utils/secret-scrub';
import { IngestEventBusService } from '../common/services/ingest-event-bus.service';
import { TenantContext } from '../common/decorators/tenant-context.decorator';
import { initSseHeaders } from '../routing/proxy/stream-writer';
import { whitelistResponseHeaders } from './playground-response-headers';
import { sanitizeRequestHeaders } from './request-header-sanitizer';
import { PlaygroundHistoryService } from './playground-history.service';
import { buildForwardBody, derivePromptForHistory } from './playground-payload';
import { consumeProviderStream } from './playground-stream';
import type { RunPlaygroundDto } from './dto/run-playground.dto';
import { ManifestRequest } from '../entities/request.entity';
import { ResolveService } from '../routing/resolve/resolve.service';
import { HeaderTierService } from '../routing/header-tiers/header-tier.service';
import { MediaService, type MediaResolvedRoute } from '../routing/media/media.service';
import { buildSyntheticTierProfile } from '../routing/proxy/synthetic-model-profile';

/**
 * A row the Playground model picker can render. Mirrors the routing
 * `available-models` row and adds `synthetic` for the `auto-{tier}` entries
 * that only the Playground lists (the routing UI never offers them).
 */
export interface PlaygroundCatalogModel {
  model_name: string;
  provider: string;
  auth_type: AuthType;
  input_price_per_token: number | null;
  output_price_per_token: number | null;
  /**
   * Absent for a pure media tier: image/video generation has no chat context
   * window, and the discovery default would be a fabricated number.
   */
  context_window?: number;
  capability_reasoning: boolean;
  capability_code: boolean;
  capabilities?: readonly string[];
  input_modalities: readonly string[];
  output_modalities: readonly string[];
  quality_score: number;
  display_name: string | null;
  synthetic: boolean;
  tier_name?: string | null;
  tier_color?: string | null;
}

/** The concrete provider/model a text run should forward to. */
interface ResolvedTextRoute {
  provider: string;
  model: string;
  authType?: AuthType;
  keyLabel?: string;
  route: PlaygroundResolvedRoute;
  /**
   * True when the request named a synthetic `auto-*` model and it resolved to
   * a real route. False for a real model and for an unresolvable synthetic one.
   */
  syntheticResolved: boolean;
}

const AUTO_TIER_PATTERN = /^auto-(.+)$/i;

@Injectable()
export class PlaygroundService {
  private readonly logger = new Logger(PlaygroundService.name);

  constructor(
    private readonly playgroundAgent: PlaygroundAgentService,
    private readonly providerKeyService: ProviderKeyService,
    private readonly providerClient: ProviderClient,
    private readonly openaiOauth: OpenaiOauthService,
    private readonly minimaxOauth: MinimaxOauthService,
    private readonly anthropicOauth: AnthropicOauthService,
    private readonly geminiOauth: GeminiOauthService,
    private readonly kiroOauth: KiroOauthService,
    private readonly xaiOauth: XaiOauthService,
    private readonly pricingCache: ModelPricingCacheService,
    private readonly eventBus: IngestEventBusService,
    private readonly history: PlaygroundHistoryService,
    @InjectRepository(AgentMessage)
    private readonly messageRepo: Repository<AgentMessage>,
    @InjectRepository(CustomProvider)
    private readonly customProviderRepo: Repository<CustomProvider>,
    private readonly customProviders: CustomProviderService,
    private readonly opencodeGoCatalog: OpencodeGoCatalogService,
    private readonly resolveService: ResolveService,
    private readonly headerTiers: HeaderTierService,
    private readonly modelDiscovery: ModelDiscoveryService,
    private readonly mediaService: MediaService,
  ) {}

  /**
   * Models the Playground can run: every discovered model plus one synthetic
   * `auto-{tier}` entry per enabled header tier that has an override route.
   * The synthetic entries execute through the real routing resolver, so the
   * Playground can test a harness's tier behaviour (primary + fallbacks)
   * without a harness.
   */
  async listModels(ctx: TenantContext): Promise<PlaygroundCatalogModel[]> {
    const agent = await this.playgroundAgent.resolve(ctx);
    const discovered = await this.modelDiscovery.getModelsForAgent(agent.tenant_id, agent.id);

    const rows: PlaygroundCatalogModel[] = discovered.map((m) => ({
      model_name: m.id,
      provider: m.provider,
      auth_type: (m.authType ?? 'api_key') as AuthType,
      input_price_per_token: m.inputPricePerToken,
      output_price_per_token: m.outputPricePerToken,
      context_window: m.contextWindow,
      capability_reasoning: m.capabilityReasoning,
      capability_code: m.capabilityCode,
      ...(m.capabilities && m.capabilities.length > 0
        ? { capabilities: m.capabilities as readonly string[] }
        : {}),
      input_modalities: m.inputModalities ?? ['text'],
      output_modalities: m.outputModalities?.length ? m.outputModalities : ['text'],
      quality_score: m.qualityScore,
      display_name: m.displayName ?? null,
      synthetic: false,
    }));

    const tiers = await this.headerTiers.list(agent.id);
    for (const tier of tiers) {
      if (!tier.enabled || !tier.override_route) continue;
      const id = `auto-${tier.name.toLowerCase()}`;
      if (rows.some((r) => r.model_name === id)) continue;
      const profile = buildSyntheticTierProfile(tier, discovered);
      rows.push({
        model_name: id,
        provider: 'manifest',
        auth_type: 'api_key',
        input_price_per_token: null,
        output_price_per_token: null,
        ...(profile.contextWindow !== undefined ? { context_window: profile.contextWindow } : {}),
        capability_reasoning: false,
        capability_code: false,
        ...(profile.features.length > 0
          ? { capabilities: profile.features as readonly string[] }
          : {}),
        input_modalities: profile.inputModalities,
        output_modalities: profile.outputModalities,
        quality_score: 0,
        display_name: `Auto · ${tier.name}`,
        synthetic: true,
        tier_name: tier.name,
        tier_color: tier.badge_color,
      });
    }

    return rows;
  }

  /**
   * Streams one model's response over SSE. Failures *before* the stream opens
   * (bad agent/provider/key, upstream non-2xx) are returned as a plain JSON
   * HTTP error — the client hasn't committed to an event stream yet. Failures
   * *after* the stream opens are delivered as a terminal `error` event.
   */
  async runStream(ctx: TenantContext, dto: RunPlaygroundDto, res: ExpressResponse): Promise<void> {
    let agent: { id: string; tenant_id: string; name: string };
    try {
      // The Playground always runs under the reserved per-tenant "Playground"
      // agent (created on first use), so runs record under it in global Messages
      // and route against the whole global provider pool — regardless of any
      // agentName the client sends.
      agent = await this.playgroundAgent.resolve(ctx);
    } catch (err) {
      const status = err instanceof HttpException ? err.getStatus() : 500;
      const message = err instanceof Error ? err.message : String(err);
      return this.sendPreStreamError(res, status, message);
    }

    const kind = await this.resolveOutputKind(agent, dto);
    if (kind !== 'text') {
      return this.runMedia(ctx, agent, dto, kind, res);
    }
    return this.runText(ctx, agent, dto, res);
  }

  /** Text / chat-completions path (the original Playground behaviour). */
  private async runText(
    ctx: TenantContext,
    agent: { id: string; tenant_id: string; name: string },
    dto: RunPlaygroundDto,
    res: ExpressResponse,
  ): Promise<void> {
    let authType: AuthType;
    let apiKey: string;
    let rawApiKey: string;
    let providerKeyLabel: string | undefined;
    let providerResource: string | undefined;
    // Region/resource inputs for the shared endpoint resolver, so Playground
    // forwarding (region overrides + vendor-prefix stripping) stays in lock-step
    // with the proxy for minimax/qwen/zai/copilot/custom.
    let oauthResourceUrl: string | undefined;
    let providerRegion: string | null | undefined;
    // The concrete provider/model the run forwards to. For a real model these
    // equal the DTO values; for a synthetic `auto-*` model they are the route
    // the tier resolver picked.
    let fwdProvider = dto.provider;
    let fwdModel = dto.model;
    let route: PlaygroundResolvedRoute = this.directRoute(dto);
    try {
      const resolvedRoute = await this.resolveTextRoute(agent, dto);
      fwdProvider = resolvedRoute.provider;
      fwdModel = resolvedRoute.model;
      route = resolvedRoute.route;

      // A synthetic `auto-*` model that resolves to no available route is a
      // configuration problem, not a missing provider connection — say so.
      if (AUTO_TIER_PATTERN.test(dto.model) && !resolvedRoute.syntheticResolved) {
        const message = `Synthetic model "${dto.model}" has no available route for this agent`;
        await this.recordRequestRejection(ctx.userId, agent, dto, 404, message, 'config');
        return this.sendPreStreamError(res, 404, message);
      }

      const hasProvider = await this.providerKeyService.hasActiveProvider(
        agent.tenant_id,
        fwdProvider,
        agent.id,
      );
      if (!hasProvider) {
        const message = `Provider "${fwdProvider}" is not connected for this agent`;
        await this.recordRequestRejection(ctx.userId, agent, dto, 404, message, 'config');
        return this.sendPreStreamError(res, 404, message);
      }
      authType =
        resolvedRoute.authType ??
        (await this.providerKeyService.getAuthType(
          agent.tenant_id,
          fwdProvider,
          undefined,
          agent.id,
        ));
      const key = await this.providerKeyService.selectProviderKey(
        agent.tenant_id,
        fwdProvider,
        authType,
        resolvedRoute.keyLabel ?? dto.providerKeyLabel,
        agent.id,
      );
      if (!key || key.apiKey === null) {
        const message = `No usable API key found for provider "${fwdProvider}"`;
        await this.recordRequestRejection(ctx.userId, agent, dto, 404, message, 'config');
        return this.sendPreStreamError(res, 404, message);
      }
      rawApiKey = key.apiKey;
      providerKeyLabel = key.label;
      providerRegion = key.region;
      const resolved = await resolveApiKey(
        fwdProvider,
        rawApiKey,
        authType,
        agent.id,
        agent.tenant_id,
        this.openaiOauth,
        this.minimaxOauth,
        this.anthropicOauth,
        this.geminiOauth,
        this.kiroOauth,
        this.xaiOauth,
        providerKeyLabel,
      );
      if (resolved.apiKey === null) {
        const message = `No usable API key found for provider "${fwdProvider}"`;
        await this.recordRequestRejection(ctx.userId, agent, dto, 404, message, 'config');
        return this.sendPreStreamError(res, 404, message);
      }
      apiKey = resolved.apiKey;
      if (authType === 'subscription' && isRefreshableOAuthCredential(rawApiKey)) {
        rawApiKey =
          (await this.providerKeyService.getProviderApiKey(
            agent.tenant_id,
            fwdProvider,
            authType,
            providerKeyLabel,
            agent.id,
          )) ?? rawApiKey;
      }
      oauthResourceUrl = authType === 'subscription' ? resolved.resourceUrl : undefined;
      // Gemini OAuth stores the CodeAssist project id (not a URL) in the same
      // field; it is forwarded as providerResource. MiniMax's resource URL is
      // applied as a base-URL override below, not here.
      providerResource =
        authType === 'subscription' && fwdProvider.toLowerCase() === 'gemini'
          ? resolved.resourceUrl
          : undefined;
    } catch (err) {
      const status = err instanceof HttpException ? err.getStatus() : 500;
      const message = err instanceof Error ? err.message : String(err);
      await this.recordRequestRejection(
        ctx.userId,
        agent,
        dto,
        status,
        message,
        status >= 500 ? 'internal' : 'config',
      );
      return this.sendPreStreamError(res, status, message);
    }

    const extraHeaders = sanitizeRequestHeaders(dto.requestHeaders);
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    // Resolve the upstream endpoint + forwarded model id through the SAME helper
    // the proxy uses, so region overrides (minimax/qwen/zai) and vendor-prefix
    // stripping (copilot/minimax/zai/custom) match. Custom providers store their
    // endpoint on a DB row, fetched here and passed in.
    const customProvider = CustomProviderService.isCustom(fwdProvider)
      ? await this.customProviderRepo.findOne({
          where: { id: CustomProviderService.extractId(fwdProvider), tenant_id: agent.tenant_id },
        })
      : null;
    const { customEndpoint, forwardModel } = resolveForwardEndpoint({
      provider: fwdProvider,
      authType,
      model: fwdModel,
      providerRegion,
      resourceUrl: oauthResourceUrl,
      customProvider,
      logger: this.logger,
    });

    const startedAt = Date.now();
    let forward;
    try {
      const forwardOptions = {
        provider: fwdProvider,
        apiKey,
        model: forwardModel,
        body: buildForwardBody(dto),
        stream: true,
        authType,
        extraHeaders,
        customEndpoint,
        signal: abort.signal,
        providerResource,
      };
      forward = await this.providerClient.forward(forwardOptions);
      if (forward.response.status === 401 && authType === 'subscription') {
        const refreshed = await refreshRejectedOAuthCredential(
          fwdProvider,
          rawApiKey,
          agent.id,
          agent.tenant_id,
          providerKeyLabel,
          {
            openaiOauth: this.openaiOauth,
            minimaxOauth: this.minimaxOauth,
            anthropicOauth: this.anthropicOauth,
            geminiOauth: this.geminiOauth,
            kiroOauth: this.kiroOauth,
            xaiOauth: this.xaiOauth,
          },
        );
        if (refreshed?.apiKey && refreshed.apiKey !== apiKey) {
          this.logger.log(
            `OAuth token rejected upstream in Playground; refreshed provider=${fwdProvider} agent=${agent.id}`,
          );
          apiKey = refreshed.apiKey;
          providerResource =
            authType === 'subscription' && fwdProvider.toLowerCase() === 'gemini'
              ? (refreshed.resourceUrl ?? providerResource)
              : providerResource;
          forward = await this.providerClient.forward({
            ...forwardOptions,
            apiKey,
            providerResource,
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!abort.signal.aborted) {
        await this.recordError(
          ctx.userId,
          agent,
          this.recordDto(dto, fwdProvider, fwdModel),
          authType,
          502,
          message,
          Date.now() - startedAt,
          'transport',
        );
      }
      return this.sendPreStreamError(res, 502, `Provider request failed: ${message}`);
    }

    const headers = whitelistResponseHeaders(forward.response.headers);

    if (!forward.response.ok) {
      let bodyText = '';
      try {
        bodyText = await forward.response.text();
      } catch {
        // A failed error-body read must not bypass provider-error handling —
        // fall through with an empty body so we still record + respond.
      }
      const durationMs = Date.now() - startedAt;
      const errorSummary = this.truncateError(bodyText, forward.response.status);
      await this.recordError(
        ctx.userId,
        agent,
        this.recordDto(dto, fwdProvider, fwdModel),
        authType,
        forward.response.status,
        bodyText,
        durationMs,
      );
      await this.history.saveColumn(
        this.errorColumn(
          ctx.userId,
          agent,
          dto,
          authType,
          headers,
          errorSummary,
          providerKeyLabel,
          route,
        ),
      );
      return this.sendPreStreamError(res, 502, errorSummary);
    }

    // Committed to SSE from here — every further failure is an in-band event.
    initSseHeaders(res, {});
    const send = (event: PlaygroundStreamEvent): void => {
      if (res.writableEnded) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    if (!forward.response.body) {
      const message = 'Provider returned an empty stream';
      await this.recordError(
        ctx.userId,
        agent,
        this.recordDto(dto, fwdProvider, fwdModel),
        authType,
        502,
        message,
        Date.now() - startedAt,
      );
      await this.history.saveColumn(
        this.errorColumn(
          ctx.userId,
          agent,
          dto,
          authType,
          headers,
          message,
          providerKeyLabel,
          route,
        ),
      );
      send({ type: 'error', message });
      res.end();
      return;
    }

    try {
      const { content, usage, ttftMs, totalMs } = await consumeProviderStream(
        forward.response.body,
        forward,
        fwdModel,
        this.providerClient,
        (text) => send({ type: 'delta', text }),
        startedAt,
      );

      const inputTokens = usage?.prompt_tokens ?? 0;
      const outputTokens = usage?.completion_tokens ?? 0;
      const cacheReadTokens = usage?.cache_read_tokens ?? 0;
      const cacheCreationTokens = usage?.cache_creation_tokens ?? 0;
      // Tile-connected local runtimes arrive as `custom:<uuid>`; only the
      // canonical provider says whether one is local. A tenant-less context
      // has no custom providers to resolve, so it degrades to the raw name.
      //
      // Best-effort by design: the answer has already been streamed to the
      // client, so a metadata lookup that fails must not turn a delivered run
      // into an error one. It only refines the cost inputs below, and the raw
      // name is where the lookup starts from anyway.
      const canonicalProvider = await this.customProviders
        .canonicalizeAgentMessageKeys(ctx.tenantId ?? '', fwdProvider, fwdModel)
        .then(({ provider }) => provider ?? fwdProvider)
        .catch(() => fwdProvider);
      const cost = computeTokenCost({
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        model: fwdModel,
        pricing: this.pricingCache.getByModel(fwdModel, fwdProvider),
        isSubscription: authType === 'subscription',
        // Same source order as the proxy recorder: a playground run against
        // the same provider must not report a different cost. That parity is
        // the whole point, so each input is resolved the way the recorder
        // resolves it — the local check on the canonical provider, because a
        // tile-connected llama.cpp arrives as `custom:<uuid>`, and the
        // per-request rate from the OpenCode Go catalogue.
        isLocalProvider: isLocalOnlyProvider(canonicalProvider),
        perRequestCostUsd:
          authType === 'subscription' &&
          PROVIDER_BY_ID_OR_ALIAS.get(canonicalProvider.toLowerCase())?.id === 'opencode-go'
            ? await this.opencodeGoCatalog.resolveCostPerRequest(fwdModel)
            : null,
        reportedCostUsd: usage?.reported_cost_usd,
        // The request start, not the completion time. A stream that opens at
        // 09:59 UTC and closes at 10:01 crossed out of a DeepSeek peak window
        // mid-answer; the proxy recorder bills such a run from `startedAt`, so
        // billing the playground from `Date.now()` would price the same run
        // two different ways.
        at: new Date(startedAt),
      });
      const tokensPerSec = outputTokens > 0 ? outputTokens / (Math.max(totalMs, 1) / 1000) : null;

      await this.recordSuccess(
        ctx.userId,
        agent,
        this.recordDto(dto, fwdProvider, fwdModel),
        authType,
        {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          cost,
          durationMs: totalMs,
        },
      );

      const columnId = await this.history.saveColumn({
        createdByUserId: ctx.userId,
        agent,
        runId: dto.runId,
        prompt: derivePromptForHistory(dto),
        model: dto.model,
        provider: dto.provider,
        authType,
        providerKeyLabel: providerKeyLabel ?? dto.providerKeyLabel ?? null,
        displayName: null,
        position: dto.position ?? 0,
        status: 'success',
        content,
        headers,
        errorMessage: null,
        metrics: { inputTokens, outputTokens, cost, durationMs: totalMs },
        kind: 'text',
        route,
      });

      send({
        type: 'done',
        columnId,
        content,
        metrics: { cost, inputTokens, outputTokens, durationMs: totalMs, ttftMs, tokensPerSec },
        headers,
        kind: 'text',
        route,
      });
      res.end();
    } catch (err) {
      // Client navigated away / removed the column — the request was aborted.
      // Nothing to report and the row would just be noise.
      if (abort.signal.aborted) {
        if (!res.writableEnded) res.end();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startedAt;
      await this.recordError(
        ctx.userId,
        agent,
        this.recordDto(dto, fwdProvider, fwdModel),
        authType,
        502,
        message,
        durationMs,
      );
      await this.history.saveColumn(
        this.errorColumn(
          ctx.userId,
          agent,
          dto,
          authType,
          headers,
          message,
          providerKeyLabel,
          route,
        ),
      );
      send({ type: 'error', message });
      if (!res.writableEnded) res.end();
    }
  }

  /**
   * Image / video path. Delegates to MediaService so routing (synthetic
   * `auto-*` tiers, header tiers, direct), credential resolution, recording
   * and pricing are identical to the real `/v1/images|videos` surface — the
   * Playground only differs in how the result reaches the client (SSE).
   */
  private async runMedia(
    ctx: TenantContext,
    agent: { id: string; tenant_id: string; name: string },
    dto: RunPlaygroundDto,
    kind: 'image' | 'video',
    res: ExpressResponse,
  ): Promise<void> {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const apiMode = kind === 'image' ? 'images' : 'videos';
    const startedAt = Date.now();

    let result: Awaited<ReturnType<MediaService['handle']>>;
    try {
      result = await this.mediaService.handle({
        ctx: {
          tenantId: agent.tenant_id,
          agentId: agent.id,
          agentName: agent.name,
          userId: ctx.userId,
        },
        body: this.buildMediaBody(dto, kind),
        headers: {},
        apiMode,
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) {
        if (!res.writableEnded) res.end();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      return this.sendPreStreamError(res, 502, `Media request failed: ${message}`);
    }

    if (abort.signal.aborted) {
      if (!res.writableEnded) res.end();
      return;
    }

    const route = this.mediaRoute(result.resolvedRoute, dto);
    const durationMs = Date.now() - startedAt;

    if (result.status >= 400) {
      const message = extractMediaErrorMessage(result.body);
      // MediaService already recorded the failure in requests/agent_messages.
      await this.history.saveColumn({
        createdByUserId: ctx.userId,
        agent,
        runId: dto.runId,
        prompt: derivePromptForHistory(dto),
        model: dto.model,
        provider: dto.provider,
        authType: dto.authType ?? null,
        providerKeyLabel: dto.providerKeyLabel ?? null,
        displayName: null,
        position: dto.position ?? 0,
        status: 'error',
        content: null,
        headers: null,
        errorMessage: message,
        metrics: null,
        kind,
        route,
      });
      return this.sendPreStreamError(res, result.status, message);
    }

    const media =
      kind === 'image'
        ? this.imageOutput(result.body, dto.responseFormat)
        : this.videoOutput(result.body);
    const metrics = this.mediaMetrics(media, result.costUsd ?? null, durationMs, dto);

    const columnId = await this.history.saveColumn({
      createdByUserId: ctx.userId,
      agent,
      runId: dto.runId,
      prompt: derivePromptForHistory(dto),
      model: dto.model,
      provider: dto.provider,
      authType: dto.authType ?? null,
      providerKeyLabel: dto.providerKeyLabel ?? null,
      displayName: null,
      position: dto.position ?? 0,
      status: 'success',
      content: null,
      headers: null,
      errorMessage: null,
      metrics: {
        inputTokens: 0,
        outputTokens: 0,
        cost: metrics.cost,
        durationMs,
      },
      kind,
      media,
      route,
    });

    initSseHeaders(res, {});
    if (!res.writableEnded) {
      const event: PlaygroundStreamEvent = {
        type: 'done',
        columnId,
        content: '',
        metrics,
        headers: {},
        kind,
        media,
        route,
      };
      res.write(`event: done\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    }
  }

  /**
   * Poll an asynchronous video task and, once it reaches a terminal status,
   * finalize the playground column's media + cost. Delegates to
   * MediaService.videoStatus for the provider call and the recording-side
   * cost finalization.
   */
  async videoStatus(
    ctx: TenantContext,
    taskId: string,
    columnId?: string,
  ): Promise<{ status: number; media: PlaygroundVideoOutput; costUsd: number | null }> {
    const agent = await this.playgroundAgent.resolve(ctx);
    const result = await this.mediaService.videoStatus(
      {
        tenantId: agent.tenant_id,
        agentId: agent.id,
        agentName: agent.name,
        userId: ctx.userId,
      },
      taskId,
    );
    const media = this.videoOutput(result.body);
    const terminal = media.status === 'completed' || media.status === 'failed';
    if (columnId && terminal) {
      const owns = await this.history.columnBelongsToAgent(agent.tenant_id, agent.id, columnId);
      if (owns) {
        await this.history.updateColumnMedia(columnId, {
          media,
          status: media.status === 'failed' ? 'error' : 'success',
          costUsd: result.costUsd ?? null,
          durationMs: null,
        });
      }
    }
    return { status: result.status, media, costUsd: result.costUsd ?? null };
  }

  /* ── Modality / route resolution ───────────────────────────────── */

  /**
   * Decide whether a run is text, image or video. An explicit `outputKind`
   * always wins; otherwise the selected model's advertised output modality
   * (or, for a synthetic `auto-*` model, its tier's configured modality)
   * decides. A prompt-only payload with no known modality defaults to image.
   */
  private async resolveOutputKind(
    agent: { id: string; tenant_id: string },
    dto: RunPlaygroundDto,
  ): Promise<PlaygroundOutputKind> {
    if (dto.outputKind) return dto.outputKind;
    try {
      if (AUTO_TIER_PATTERN.test(dto.model)) {
        const resolved = await this.resolveService.resolveAutoTierModel(
          agent.id,
          agent.tenant_id,
          dto.model,
        );
        if (resolved?.output_modality === 'image' || resolved?.output_modality === 'video') {
          return resolved.output_modality;
        }
        if (resolved) return 'text';
      }
      const models = await this.modelDiscovery.getModelsForAgent(agent.tenant_id, agent.id);
      const match =
        models.find(
          (m) => m.id === dto.model && m.provider.toLowerCase() === dto.provider.toLowerCase(),
        ) ?? models.find((m) => m.id === dto.model);
      const modalities = match?.outputModalities ?? [];
      if (modalities.includes('video')) return 'video';
      if (modalities.includes('image')) return 'image';
    } catch (err) {
      this.logger.warn(
        `Playground modality inference failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    return dto.prompt ? 'image' : 'text';
  }

  /**
   * Resolve the concrete provider/model a text run forwards to. A synthetic
   * `auto-{tier}` model is resolved through the same tier resolver the proxy
   * uses (override route → available fallbacks); everything else passes
   * through unchanged.
   */
  private async resolveTextRoute(
    agent: { id: string; tenant_id: string },
    dto: RunPlaygroundDto,
  ): Promise<ResolvedTextRoute> {
    if (AUTO_TIER_PATTERN.test(dto.model)) {
      const resolved = await this.resolveService.resolveAutoTierModel(
        agent.id,
        agent.tenant_id,
        dto.model,
      );
      if (resolved?.route) {
        return {
          provider: resolved.route.provider,
          model: resolved.route.model,
          authType: resolved.route.authType ?? dto.authType,
          keyLabel: resolved.route.keyLabel ?? undefined,
          route: {
            provider: resolved.route.provider,
            model: resolved.route.model,
            tier: resolved.header_tier_name ?? null,
            tierColor: resolved.header_tier_color ?? null,
            synthetic: true,
            requestedModel: dto.model,
          },
          syntheticResolved: true,
        };
      }
    }
    return {
      provider: dto.provider,
      model: dto.model,
      authType: dto.authType,
      keyLabel: dto.providerKeyLabel,
      route: this.directRoute(dto),
      syntheticResolved: false,
    };
  }

  private directRoute(dto: RunPlaygroundDto): PlaygroundResolvedRoute {
    return {
      provider: dto.provider,
      model: dto.model,
      tier: null,
      tierColor: null,
      synthetic: AUTO_TIER_PATTERN.test(dto.model),
      requestedModel: dto.model,
    };
  }

  private mediaRoute(
    resolved: MediaResolvedRoute | null | undefined,
    dto: RunPlaygroundDto,
  ): PlaygroundResolvedRoute | null {
    if (!resolved) return null;
    return {
      provider: resolved.provider,
      model: resolved.model,
      tier: resolved.headerTierName ?? resolved.tier ?? null,
      tierColor: resolved.headerTierColor ?? null,
      synthetic: AUTO_TIER_PATTERN.test(dto.model),
      requestedModel: dto.model,
    };
  }

  /* ── Media helpers ─────────────────────────────────────────────── */

  private buildMediaBody(dto: RunPlaygroundDto, kind: 'image' | 'video'): Record<string, unknown> {
    const body: Record<string, unknown> = { model: dto.model, prompt: dto.prompt ?? '' };
    if (kind === 'image') {
      if (dto.n != null) body.n = dto.n;
      if (dto.size) body.size = dto.size;
      if (dto.ratio) body.ratio = dto.ratio;
      if (dto.responseFormat) body.response_format = dto.responseFormat;
      if (dto.referenceImages?.length) body.image = dto.referenceImages;
      return body;
    }
    if (dto.size) body.size = dto.size;
    if (dto.ratio) body.ratio = dto.ratio;
    if (dto.seconds != null) body.seconds = dto.seconds;
    if (dto.mode) body.mode = dto.mode;
    if (dto.firstFrame) body.first_frame = dto.firstFrame;
    if (dto.lastFrame) body.last_frame = dto.lastFrame;
    if (dto.referenceImages?.length) body.images = dto.referenceImages;
    return body;
  }

  private imageOutput(body: unknown, responseFormat?: string): PlaygroundImageOutput {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const data = record['data'];
    const images = Array.isArray(data)
      ? data.filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
      : [];
    return {
      kind: 'image',
      images: images as PlaygroundImageOutput['images'],
      responseFormat: responseFormat ?? null,
    };
  }

  private videoOutput(body: unknown): PlaygroundVideoOutput {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const status = (
      typeof record['status'] === 'string' ? record['status'] : 'queued'
    ) as VideoStatus;
    const errorRecord = record['error'];
    const error =
      typeof errorRecord === 'string'
        ? errorRecord
        : errorRecord && typeof errorRecord === 'object'
          ? (((errorRecord as { message?: unknown }).message as string | undefined) ?? null)
          : null;
    return {
      kind: 'video',
      taskId: typeof record['id'] === 'string' ? record['id'] : '',
      status,
      ...(typeof record['url'] === 'string' ? { url: record['url'] } : {}),
      ...(typeof record['seconds'] === 'number' ? { seconds: record['seconds'] } : {}),
      ...(typeof record['size'] === 'string' ? { size: record['size'] } : {}),
      ...(typeof record['progress'] === 'number' ? { progress: record['progress'] } : {}),
      error,
    };
  }

  private mediaMetrics(
    media: PlaygroundMediaOutput,
    cost: number | null,
    durationMs: number,
    dto: RunPlaygroundDto,
  ): PlaygroundMetrics {
    return {
      cost,
      inputTokens: 0,
      outputTokens: 0,
      durationMs,
      ...(media.kind === 'image' ? { imageCount: media.images.length } : {}),
      ...(media.kind === 'video' ? { videoSeconds: media.seconds ?? dto.seconds ?? null } : {}),
    };
  }

  /** A DTO copy that records the concrete provider/model that served the run. */
  private recordDto(dto: RunPlaygroundDto, provider: string, model: string): RunPlaygroundDto {
    return { ...dto, provider, model };
  }

  private sendPreStreamError(res: ExpressResponse, status: number, message: string): void {
    if (res.headersSent || res.writableEnded) return;
    res.status(status).json({ statusCode: status, message });
  }

  private errorColumn(
    createdByUserId: string | null,
    agent: { id: string; tenant_id: string; name: string },
    dto: RunPlaygroundDto,
    authType: AuthType,
    headers: Record<string, string>,
    errorMessage: string,
    providerKeyLabel?: string,
    route?: PlaygroundResolvedRoute | null,
  ): Parameters<PlaygroundHistoryService['saveColumn']>[0] {
    return {
      createdByUserId,
      agent,
      runId: dto.runId,
      prompt: derivePromptForHistory(dto),
      model: dto.model,
      provider: dto.provider,
      authType,
      providerKeyLabel: providerKeyLabel ?? dto.providerKeyLabel ?? null,
      displayName: null,
      position: dto.position ?? 0,
      status: 'error',
      content: null,
      headers,
      errorMessage,
      metrics: null,
      kind: 'text',
      route: route ?? null,
    };
  }

  private async recordSuccess(
    createdByUserId: string | null,
    agent: { id: string; tenant_id: string; name: string },
    dto: RunPlaygroundDto,
    authType: AuthType,
    metrics: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      cost: number | null;
      durationMs: number;
    },
  ): Promise<void> {
    // Guarded: the model already produced (and was billed for) a completion we
    // just streamed to the user. A telemetry-insert blip must not turn that
    // into a user-visible failure.
    try {
      // No tenant_provider_id: Playground runs use the reserved is_playground agent,
      // which excludePlaygroundAgents() filters out of every per-connection view,
      // so stamping the connection here would have no analytic effect.
      const requestId = uuid();
      const timestamp = new Date().toISOString();
      await this.insertPlaygroundRequest(
        {
          id: uuid(),
          request_id: requestId,
          attempt_number: 1,
          tenant_id: agent.tenant_id,
          agent_id: agent.id,
          agent_name: agent.name,
          // Informational attribution only — never used for scoping.
          user_id: createdByUserId,
          timestamp,
          status: 'success',
          model: dto.model,
          provider: dto.provider,
          routing_tier: 'playground',
          routing_reason: null,
          auth_type: authType,
          input_tokens: metrics.inputTokens,
          output_tokens: metrics.outputTokens,
          cache_read_tokens: metrics.cacheReadTokens,
          cache_creation_tokens: metrics.cacheCreationTokens,
          cost_usd: metrics.cost,
          duration_ms: metrics.durationMs,
        },
        {
          id: requestId,
          tenant_id: agent.tenant_id,
          agent_id: agent.id,
          user_id: createdByUserId,
          agent_name: agent.name,
          trace_id: null,
          session_key: null,
          session_id: null,
          timestamp,
          duration_ms: metrics.durationMs,
          status: 'success',
          autofix_status: null,
          recovered_by_key_rotation: false,
          error_message: null,
          error_http_status: null,
          error_code: null,
          error_origin: null,
          error_class: null,
          requested_model: dto.model,
          // The Playground calls a provider directly; it never enters through
          // one of the proxy's public API surfaces.
          api_mode: null,
          media_task_id: null,
          caller_attribution: null,
          request_headers: null,
          request_params: null,
          feedback_rating: null,
          feedback_tags: null,
          feedback_details: null,
        },
      );
      this.eventBus.emit(agent.tenant_id);
    } catch (err) {
      this.logger.warn(
        `Failed to record playground success: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async recordError(
    createdByUserId: string | null,
    agent: { id: string; tenant_id: string; name: string },
    dto: RunPlaygroundDto,
    authType: AuthType,
    status: number,
    errorBody: string,
    durationMs: number,
    errorOrigin: 'provider' | 'transport' = 'provider',
  ): Promise<void> {
    try {
      // No tenant_provider_id — see recordSuccess: Playground is a system agent,
      // excluded from per-connection analytics.
      const requestId = uuid();
      const timestamp = new Date().toISOString();
      const errorMessage = scrubSecrets(errorBody).slice(0, 2000);
      await this.insertPlaygroundRequest(
        {
          id: uuid(),
          request_id: requestId,
          attempt_number: 1,
          tenant_id: agent.tenant_id,
          agent_id: agent.id,
          agent_name: agent.name,
          // Informational attribution only — never used for scoping.
          user_id: createdByUserId,
          timestamp,
          status: 'failed',
          // Some providers echo the submitted key back in their error body, so
          // scrub before persisting — mirrors the proxy recorder's hardening.
          error_message: errorMessage,
          error_http_status: status,
          error_origin: errorOrigin,
          model: dto.model,
          provider: dto.provider,
          routing_tier: 'playground',
          routing_reason: null,
          auth_type: authType,
          duration_ms: durationMs,
        },
        {
          id: requestId,
          tenant_id: agent.tenant_id,
          agent_id: agent.id,
          user_id: createdByUserId,
          agent_name: agent.name,
          trace_id: null,
          session_key: null,
          session_id: null,
          timestamp,
          duration_ms: durationMs,
          status: 'failed',
          autofix_status: null,
          recovered_by_key_rotation: false,
          error_message: errorMessage,
          error_http_status: status,
          error_code: null,
          error_origin: errorOrigin,
          error_class: null,
          requested_model: dto.model,
          // The Playground calls a provider directly; it never enters through
          // one of the proxy's public API surfaces.
          api_mode: null,
          media_task_id: null,
          caller_attribution: null,
          request_headers: null,
          request_params: null,
          feedback_rating: null,
          feedback_tags: null,
          feedback_details: null,
        },
      );
      this.eventBus.emit(agent.tenant_id);
    } catch (err) {
      this.logger.warn(
        `Failed to record playground error: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async recordRequestRejection(
    createdByUserId: string | null,
    agent: { id: string; tenant_id: string; name: string },
    dto: RunPlaygroundDto,
    status: number,
    errorBody: string,
    errorOrigin: 'config' | 'request' | 'internal',
  ): Promise<void> {
    try {
      const getRepository = this.messageRepo.manager?.getRepository?.bind(this.messageRepo.manager);
      if (!getRepository) return;
      const errorMessage = scrubSecrets(errorBody).slice(0, 2000);
      await getRepository(ManifestRequest).insert({
        id: uuid(),
        tenant_id: agent.tenant_id,
        agent_id: agent.id,
        user_id: createdByUserId,
        agent_name: agent.name,
        trace_id: null,
        session_key: null,
        session_id: null,
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        status: 'failed',
        autofix_status: null,
        error_message: errorMessage,
        error_http_status: status,
        error_code: null,
        error_origin: errorOrigin,
        error_class: null,
        requested_model: dto.model,
        caller_attribution: null,
        request_headers: null,
        request_params: null,
        feedback_rating: null,
        feedback_tags: null,
        feedback_details: null,
      });
      this.eventBus.emit(agent.tenant_id);
    } catch (err) {
      this.logger.warn(
        `Failed to record playground rejection: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async insertPlaygroundRequest(
    attempt: Partial<AgentMessage>,
    request: ManifestRequest,
  ): Promise<void> {
    const getRepository = this.messageRepo.manager?.getRepository?.bind(this.messageRepo.manager);
    if (!getRepository) {
      await this.messageRepo.insert(attempt);
      return;
    }
    await getRepository(ManifestRequest).insert(request);
    await this.messageRepo.insert(attempt);
  }

  private truncateError(bodyText: string, status: number): string {
    // Scrub before truncating: this snippet is both streamed back to the client
    // and stored on the history column, so a key-echoing upstream error must not
    // leak through either sink.
    const snippet = scrubSecrets(bodyText).slice(0, 500).trim();
    return snippet ? `Provider returned ${status}: ${snippet}` : `Provider returned ${status}`;
  }
}

/** Best-effort human-readable message from a media error envelope. */
function extractMediaErrorMessage(body: unknown): string {
  if (typeof body === 'string' && body.length > 0) return body;
  if (body && typeof body === 'object') {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'string' && error.length > 0) return error;
    if (error && typeof error === 'object') {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message.length > 0) return message;
    }
  }
  return 'Media provider request failed';
}
