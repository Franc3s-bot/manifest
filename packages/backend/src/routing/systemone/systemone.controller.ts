import { Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response as ExpressResponse } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { AgentKeyAuthGuard } from '../../otlp/guards/agent-key-auth.guard';
import { IngestionContext } from '../../otlp/interfaces/ingestion-context.interface';
import { SYSTEMONE_ROUTE, SYSTEMONE_ROUTE_ALIAS } from './systemone.constants';
import { SystemOneService } from './systemone.service';

/**
 * Classifier surface.
 *
 *   POST /zen/v1/systemone   System One classifier proxy (OpenCode Zen)
 *   POST /v1/systemone       alias for clients that only know `/v1`
 *
 * The path mirrors OpenCode Zen's own route, so a client can point a provider's
 * base URL at `<manifest>/zen/v1` and reuse its System One transport verbatim.
 * Authentication is the same agent key as the chat proxy; the upstream
 * credential is the tenant's existing OpenCode Zen connection.
 */
@Controller()
@Public()
@UseGuards(AgentKeyAuthGuard)
@SkipThrottle()
export class SystemOneController {
  constructor(private readonly systemOneService: SystemOneService) {}

  @Post([SYSTEMONE_ROUTE, SYSTEMONE_ROUTE_ALIAS])
  async classify(
    @Req() req: Request & { ingestionContext: IngestionContext },
    @Res() res: ExpressResponse,
  ): Promise<void> {
    const clientAbort = new AbortController();
    res.once('close', () => clientAbort.abort());

    const result = await this.systemOneService.classify({
      tenantId: req.ingestionContext.tenantId,
      agentId: req.ingestionContext.agentId,
      body: (req.body ?? {}) as Record<string, unknown>,
      signal: clientAbort.signal,
    });

    if (res.writableEnded) return;
    if (result.raw) {
      res.status(result.status).type('text/plain').send(result.body);
      return;
    }
    res.status(result.status).json(result.body);
  }
}
