import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CustomProvider } from '../entities/custom-provider.entity';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { CustomProviderMetadataService } from './custom-provider-metadata.service';
import { ModelDiscoveryService } from './model-discovery.service';
import { ProviderModelFetcherService } from './provider-model-fetcher.service';

/**
 * Guards the live custom-provider overlay against a silent wiring failure.
 *
 * `emitDecoratorMetadata` types a `T | null` constructor parameter as `Object`,
 * so Nest can resolve it only through an explicit `@Inject(...)` token — every
 * other injectable in this class carries one for that reason. Without a token
 * the dependency arrives as `undefined` (the parameter is `@Optional()` and the
 * whole overlay then no-ops), which unit tests that construct the service with
 * `new` cannot observe: they pass the stub positionally.
 */
describe('ModelDiscoveryService dependency injection', () => {
  it('receives the custom-provider live-metadata service', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ModelDiscoveryService,
        CustomProviderMetadataService,
        { provide: ProviderModelFetcherService, useValue: {} },
        { provide: getRepositoryToken(TenantProvider), useValue: {} },
        { provide: getRepositoryToken(CustomProvider), useValue: {} },
      ],
    }).compile();

    const service = moduleRef.get(ModelDiscoveryService) as unknown as {
      customMetadata?: unknown;
    };

    expect(service.customMetadata).toBeInstanceOf(CustomProviderMetadataService);
  });
});
