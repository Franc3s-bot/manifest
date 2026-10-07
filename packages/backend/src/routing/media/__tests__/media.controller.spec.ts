import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AgentKeyAuthGuard } from '../../../otlp/guards/agent-key-auth.guard';
import { ProxyExceptionFilter } from '../../proxy/proxy-exception.filter';
import { MediaController } from '../media.controller';
import { MediaService } from '../media.service';

const ctx = { tenantId: 't1', agentId: 'a1', agentName: 'agent', userId: 'u1' };

describe('MediaController (HTTP)', () => {
  let app: INestApplication;
  const service = { handle: jest.fn(), videoStatus: jest.fn() };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [MediaController],
      providers: [{ provide: MediaService, useValue: service }],
    })
      .overrideGuard(AgentKeyAuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => { getRequest: () => Record<string, unknown> };
        }) => {
          context.switchToHttp().getRequest()['ingestionContext'] = ctx;
          return true;
        },
      })
      // The filter is wired at the controller; its own deps are exercised by
      // the proxy specs, so the HTTP-shape test only needs it not to crash.
      .overrideFilter(ProxyExceptionFilter)
      .useValue({ catch: () => undefined })
      .compile();
    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    service.handle.mockReset();
    service.videoStatus.mockReset();
  });

  it('POST /v1/images/generations forwards as the images surface', async () => {
    service.handle.mockResolvedValue({ status: 200, body: { created: 1, data: [{ url: 'u' }] } });

    const res = await request(app.getHttpServer())
      .post('/v1/images/generations')
      .send({ model: 'auto-image', prompt: 'a cat' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 1, data: [{ url: 'u' }] });
    expect(service.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        apiMode: 'images',
        ctx,
        body: expect.objectContaining({ prompt: 'a cat' }),
      }),
    );
  });

  it('POST /v1/videos forwards as the videos surface', async () => {
    service.handle.mockResolvedValue({ status: 200, body: { id: 'vid_1', object: 'video' } });

    const res = await request(app.getHttpServer())
      .post('/v1/videos')
      .send({ model: 'auto-video', prompt: 'a clip' });

    expect(res.status).toBe(200);
    expect(service.handle).toHaveBeenCalledWith(expect.objectContaining({ apiMode: 'videos' }));
  });

  it('GET /v1/videos/:id polls the task', async () => {
    service.videoStatus.mockResolvedValue({
      status: 200,
      body: { id: 'vid_1', status: 'completed' },
    });

    const res = await request(app.getHttpServer()).get('/v1/videos/vid_1');

    expect(res.status).toBe(200);
    expect(service.videoStatus).toHaveBeenCalledWith(ctx, 'vid_1');
  });

  it('passes a media error status through', async () => {
    service.handle.mockResolvedValue({
      status: 400,
      body: { error: { message: 'bad', type: 'invalid_request_error' } },
    });

    const res = await request(app.getHttpServer())
      .post('/v1/images/generations')
      .send({ prompt: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('bad');
  });
});
