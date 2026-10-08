import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentMessage } from '../../entities/agent-message.entity';
import { ManifestRequest } from '../../entities/request.entity';
import { BillingModule } from '../../billing/billing.module';
import { ModelDiscoveryModule } from '../../model-discovery/model-discovery.module';
import { OtlpModule } from '../../otlp/otlp.module';
import { OAuthModule } from '../oauth/oauth.module';
import { ProxyModule } from '../proxy/proxy.module';
import { ResolveModule } from '../resolve/resolve.module';
import { RoutingCoreModule } from '../routing-core/routing-core.module';
import { MediaController } from './media.controller';
import { MediaProviderClient } from './media-provider-client';
import { MediaService } from './media.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ManifestRequest, AgentMessage]),
    RoutingCoreModule,
    ResolveModule,
    ModelDiscoveryModule,
    OAuthModule,
    BillingModule,
    // Provides AgentKeyAuthGuard (and the api-key/agent repos it needs) for
    // the media controller, plus the shared rate limiter and recorder below.
    OtlpModule,
    // Shares the proxy's rate limiter and message recorder instances so media
    // and text traffic count against the same tenant limits and land in the
    // same requests/agent_messages tables.
    ProxyModule,
  ],
  controllers: [MediaController],
  providers: [MediaService, MediaProviderClient],
  exports: [MediaService],
})
export class MediaModule {}
