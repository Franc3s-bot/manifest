import type { AuthType } from 'manifest-shared';
import { isMinimaxRegion } from './oauth/minimax/minimax-oauth-helpers';
import { isXiaomiProviderId, isXiaomiTokenPlanRegion } from './xiaomi-region';
import { isZaiCodingPlanRegion, isZaiProviderId } from './zai-region';

export interface SubscriptionEndpointRegionConfig {
  isRegion: (value: string | null | undefined) => boolean;
  matchesProvider: (provider: string) => boolean;
  validationMessage: string;
}

export function isCommandCodePlan(value: string | null | undefined): boolean {
  if (!value) return true;
  const lower = value.toLowerCase().trim();
  return (
    lower === 'go' ||
    lower === 'goat' ||
    lower === 'pro' ||
    lower.startsWith('http://') ||
    lower.startsWith('https://')
  );
}

const SUBSCRIPTION_ENDPOINT_REGION_CONFIGS: readonly SubscriptionEndpointRegionConfig[] = [
  {
    matchesProvider: (provider) => provider === 'minimax',
    isRegion: (value) => isMinimaxRegion(value ?? undefined),
    validationMessage: 'MiniMax subscription region must be one of: global, cn',
  },
  {
    matchesProvider: isXiaomiProviderId,
    isRegion: isXiaomiTokenPlanRegion,
    validationMessage: 'Xiaomi MiMo Token Plan region must be one of: cn, sgp, ams',
  },
  {
    matchesProvider: isZaiProviderId,
    isRegion: isZaiCodingPlanRegion,
    validationMessage: 'Z.ai subscription region must be one of: global, cn',
  },
  {
    matchesProvider: (provider) => provider === 'commandcode',
    isRegion: isCommandCodePlan,
    validationMessage: 'Command Code subscription plan must be one of: go, goat, pro',
  },
];

export function getSubscriptionEndpointRegionConfig(
  provider: string | null | undefined,
  authType: AuthType | undefined,
): SubscriptionEndpointRegionConfig | null {
  if (authType !== 'subscription') return null;
  const lowerProvider = provider?.toLowerCase();
  if (!lowerProvider) return null;
  return (
    SUBSCRIPTION_ENDPOINT_REGION_CONFIGS.find((config) => config.matchesProvider(lowerProvider)) ??
    null
  );
}
