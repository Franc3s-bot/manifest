import { Module } from '@nestjs/common';
import { OtlpModule } from '../../otlp/otlp.module';
import { RoutingCoreModule } from '../routing-core/routing-core.module';
import { SystemOneController } from './systemone.controller';
import { SystemOneService } from './systemone.service';

/**
 * Classifier route. Shares the proxy's agent-key auth (`OtlpModule`) and the
 * OpenCode Zen credential resolution (`RoutingCoreModule`); it deliberately
 * does not join the chat proxy's route resolution, so classifier traffic can
 * never affect chat routing.
 */
@Module({
  imports: [RoutingCoreModule, OtlpModule],
  controllers: [SystemOneController],
  providers: [SystemOneService],
  exports: [SystemOneService],
})
export class SystemOneModule {}
