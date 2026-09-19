/**
 * Live-metadata overlay for custom providers.
 *
 * `ModelDiscoveryService.getModelsForAgent()` reads the *stored* custom provider
 * model list, which cannot know per-launch facts (a local server's context
 * window changes with every `-c/--ctx-size`, tool support depends on the chat
 * template). This service asks the running server instead and overlays what it
 * reports on top of the stored facts, so `/v1/models` — and the synthetic
 * `auto-{tier}` profiles built from it — advertise the truth for the current
 * session.
 *
 * Freshness: a 15s TTL (the facts only change when the operator restarts the
 * server), in-flight de-duplication so parallel requests share one probe, and a
 * hard 2s timeout. Any failure is a no-op: the stored values stay.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { DiscoveredModel } from './model-fetcher';
import { mergeModelCapabilities } from './model-capabilities';
import {
  fetchLiveProviderFacts,
  type LiveProbeTarget,
  type LiveProviderFacts,
} from './custom-provider-live-metadata';

/** The facts change only when the operator relaunches the server. */
export const LIVE_FACTS_TTL_MS = 15_000;

const CUSTOM_PROVIDER_PREFIX = 'custom:';

interface CacheEntry {
  facts: LiveProviderFacts | null;
  expiresAt: number;
}

@Injectable()
export class CustomProviderMetadataService {
  private readonly logger = new Logger(CustomProviderMetadataService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<LiveProviderFacts | null>>();

  /** Probe one provider, sharing concurrent callers and honouring the TTL. */
  async getFacts(target: LiveProbeTarget): Promise<LiveProviderFacts | null> {
    const key = target.providerKey.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.facts;
    if (cached) this.cache.delete(key);

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const probe = fetchLiveProviderFacts(target)
      .catch((err: unknown) => {
        this.logger.debug(
          `Live metadata probe failed for ${target.providerKey}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      })
      .then((facts) => {
        for (const [cachedKey, entry] of this.cache) {
          if (entry.expiresAt <= Date.now()) this.cache.delete(cachedKey);
        }
        this.cache.set(key, { facts, expiresAt: Date.now() + LIVE_FACTS_TTL_MS });
        this.inflight.delete(key);
        return facts;
      });
    this.inflight.set(key, probe);
    return probe;
  }

  /** Drop cached facts (provider edited, deleted, or its models refreshed). */
  invalidate(providerKey: string): void {
    this.cache.delete(providerKey.toLowerCase());
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Overlay live facts on the custom-provider entries of a discovered-model
   * list. Entries are matched by the model name the user stored (`displayName`),
   * then by the provider's single-model fallback. Returns the input array
   * untouched when nothing applies.
   */
  async applyLiveFacts(
    models: readonly DiscoveredModel[],
    targets: readonly LiveProbeTarget[],
  ): Promise<DiscoveredModel[]> {
    if (targets.length === 0 || models.length === 0) return models as DiscoveredModel[];
    if (!models.some((model) => model.provider.toLowerCase().startsWith(CUSTOM_PROVIDER_PREFIX))) {
      return models as DiscoveredModel[];
    }

    const targetByKey = new Map(targets.map((t) => [t.providerKey.toLowerCase(), t]));
    const factsByKey = new Map<string, LiveProviderFacts | null>();
    await Promise.all(
      [...targetByKey.keys()].map(async (key) => {
        factsByKey.set(key, await this.getFacts(targetByKey.get(key)!));
      }),
    );

    let changed = false;
    const out = models.map((model) => {
      const providerKey = model.provider.toLowerCase();
      if (!providerKey.startsWith(CUSTOM_PROVIDER_PREFIX)) return model;
      const providerFacts = factsByKey.get(providerKey);
      if (!providerFacts) return model;

      const name = (
        model.displayName || model.id.slice(model.id.lastIndexOf('/') + 1)
      ).toLowerCase();
      const live = providerFacts.byName.get(name) ?? providerFacts.single;
      if (!live) return model;

      const contextWindow = live.contextWindow ?? model.contextWindow;
      const capabilities = mergeModelCapabilities(model.capabilities, live.capabilities);
      const inputModalities = live.inputModalities ?? model.inputModalities;
      const outputModalities = live.outputModalities ?? model.outputModalities;
      if (
        contextWindow === model.contextWindow &&
        capabilities === model.capabilities &&
        inputModalities === model.inputModalities &&
        outputModalities === model.outputModalities
      ) {
        return model;
      }

      changed = true;
      return { ...model, contextWindow, capabilities, inputModalities, outputModalities };
    });

    return changed ? out : (models as DiscoveredModel[]);
  }
}
