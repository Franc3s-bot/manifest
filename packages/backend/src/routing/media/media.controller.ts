import { Controller, Get, Param, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { Request, Response as ExpressResponse } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { AgentKeyAuthGuard } from '../../otlp/guards/agent-key-auth.guard';
import { IngestionContext } from '../../otlp/interfaces/ingestion-context.interface';
import { ProxyExceptionFilter } from '../proxy/proxy-exception.filter';
import { MediaService } from './media.service';

/**
 * OpenAI-compatible media generation surface.
 *
 *   POST /v1/images/generations   synchronous image generation
 *   POST /v1/videos               asynchronous video task creation
 *   GET  /v1/videos/{id}          video task status (and cost finalization)
 *
 * Routing, credentials, recording, and cost accounting are shared with the
 * text proxy; only the wire shapes differ.
 */
@Controller('v1')
@Public()
@UseGuards(AgentKeyAuthGuard)
@UseFilters(ProxyExceptionFilter)
@SkipThrottle()
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post('images/generations')
  async images(
    @Req() req: Request & { ingestionContext: IngestionContext },
    @Res() res: ExpressResponse,
  ): Promise<void> {
    const clientAbort = new AbortController();
    res.once('close', () => clientAbort.abort());
    const result = await this.mediaService.handle({
      ctx: req.ingestionContext,
      body: (req.body ?? {}) as Record<string, unknown>,
      headers: req.headers,
      apiMode: 'images',
      ip: req.ip,
      signal: clientAbort.signal,
    });
    if (!res.writableEnded) res.status(result.status).json(result.body);
  }

  @Post('videos')
  async videos(
    @Req() req: Request & { ingestionContext: IngestionContext },
    @Res() res: ExpressResponse,
  ): Promise<void> {
    const clientAbort = new AbortController();
    res.once('close', () => clientAbort.abort());
    const result = await this.mediaService.handle({
      ctx: req.ingestionContext,
      body: (req.body ?? {}) as Record<string, unknown>,
      headers: req.headers,
      apiMode: 'videos',
      ip: req.ip,
      signal: clientAbort.signal,
    });
    if (!res.writableEnded) res.status(result.status).json(result.body);
  }

  @Get('videos/:id')
  async videoStatus(
    @Req() req: Request & { ingestionContext: IngestionContext },
    @Res() res: ExpressResponse,
    @Param('id') id: string,
  ): Promise<void> {
    const result = await this.mediaService.videoStatus(req.ingestionContext, id);
    if (!res.writableEnded) res.status(result.status).json(result.body);
  }
}
