import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import {
  createTestApp,
  TEST_OTLP_KEY,
  TEST_API_KEY,
  TEST_AGENT_ID,
  TEST_TENANT_ID,
} from './helpers';
import { ModelDiscoveryService } from '../src/model-discovery/model-discovery.service';
import { RoutingCacheService } from '../src/routing/routing-core/routing-cache.service';

/**
 * `/v1/models?capabilities=true&cost=true` must carry everything a client
 * needs to build a model picker and size a context window without a
 * third-party catalog: the concrete chat window, the media endpoint and price,
 * and an explicit marker for the synthetic router tiers.
 */
let app: INestApplication;
let ds: DataSource;
let upstream: Server;
let upstreamBodies: { url: string; body: Record<string, unknown> }[];

const IMAGE_MODEL = 'agnes-image-2.1-flash';
const CHAT_MODEL = 'agnes-2.5-flash';

beforeAll(async () => {
  // A stand-in for the Agnes API so the media path can be exercised end to
  // end: it records the upstream body and answers with one generated image.
  upstreamBodies = [];
  upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        body = { unparsed: raw };
      }
      upstreamBodies.push({ url: req.url ?? '', body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ created: 1, data: [{ url: 'https://example.com/img.png' }] }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address() as AddressInfo;
  process.env['AGNES_BASE_URL'] = `http://127.0.0.1:${port}/v1`;

  app = await createTestApp();
  ds = app.get(DataSource);

  await request(app.getHttpServer())
    .post('/api/v1/routing/test-agent/providers')
    .set('x-api-key', TEST_API_KEY)
    .send({ provider: 'agnes', apiKey: 'sk-fake-agnes-key' })
    .expect(201);

  const models = JSON.stringify([
    {
      id: CHAT_MODEL,
      displayName: 'Agnes 2.5 Flash',
      provider: 'agnes',
      contextWindow: 524_288,
      contextWindowSource: 'provider',
      maxOutputTokens: 65_536,
      inputPricePerToken: 0,
      outputPricePerToken: 0,
      capabilityReasoning: true,
      capabilityCode: true,
      qualityScore: 3,
      capabilities: ['text', 'stream', 'tools'],
      inputModalities: ['text'],
      outputModalities: ['text'],
    },
    {
      id: IMAGE_MODEL,
      displayName: 'Agnes Image 2.1 Flash',
      provider: 'agnes',
      contextWindow: 128_000,
      contextWindowSource: 'provider_default',
      inputPricePerToken: null,
      outputPricePerToken: null,
      capabilityReasoning: false,
      capabilityCode: false,
      qualityScore: 2,
      capabilities: ['text', 'image'],
      inputModalities: ['text', 'image'],
      outputModalities: ['image'],
      supportedEndpoints: ['/v1/images/generations'],
    },
  ]);
  await ds.query(
    `UPDATE tenant_providers SET cached_models = $1 WHERE tenant_id = $2 AND provider = $3`,
    [models, TEST_TENANT_ID, 'agnes'],
  );

  // An image tier named "image" publishes as `auto-image`.
  await ds.query(
    `INSERT INTO header_tiers
       (id, tenant_id, agent_id, name, header_key, header_value, badge_color, sort_order,
        enabled, override_route, fallback_routes, output_modality, response_mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9::jsonb,null,$10,$11)`,
    [
      'tier-image-e2e',
      TEST_TENANT_ID,
      TEST_AGENT_ID,
      'image',
      'x-manifest-complexity',
      'image',
      'blue',
      0,
      JSON.stringify({ provider: 'agnes', authType: 'api_key', model: IMAGE_MODEL }),
      'image',
      'buffered',
    ],
  );

  app.get(ModelDiscoveryService).invalidate(TEST_AGENT_ID);
  const routingCache = app.get(RoutingCacheService);
  routingCache.invalidateAgent(TEST_AGENT_ID);
  routingCache.invalidateTenant(TEST_TENANT_ID);
}, 30000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
  delete process.env['AGNES_BASE_URL'];
});

const api = () => request(app.getHttpServer());
const bearer = (r: request.Test) => r.set('Authorization', `Bearer ${TEST_OTLP_KEY}`);

describe('Model capability projection E2E', () => {
  it('publishes context windows, media endpoints, prices and the router marker', async () => {
    const res = await bearer(api().get('/v1/models?capabilities=true&cost=true')).expect(200);

    const byId = new Map((res.body.data as { id: string }[]).map((entry) => [entry.id, entry]));

    // A concrete chat model carries a real, client-usable window.
    const chat = byId.get(`agnes/${CHAT_MODEL}`) as Record<string, unknown>;
    expect(chat).toBeDefined();
    expect(chat.capabilities).toMatchObject({
      context_window: 524_288,
      max_output_tokens: 65_536,
    });

    // A media model carries its endpoint and a media price instead of tokens.
    const image = byId.get(`agnes/${IMAGE_MODEL}`) as Record<string, unknown>;
    expect(image).toBeDefined();
    expect(image.capabilities).toMatchObject({
      output_modalities: ['image'],
      supported_endpoints: ['/v1/images/generations'],
    });
    expect(image.capabilities).not.toHaveProperty('context_window');
    expect(image.media_cost).toMatchObject({ unit: 'image' });
    expect(image.cost).toBeUndefined();

    // The router is detectable from the response alone.
    const auto = byId.get('auto') as Record<string, unknown>;
    expect(auto.capabilities).toMatchObject({ synthetic: true, features: ['router'] });

    // A media tier has no chat context window.
    const autoImage = byId.get('auto-image') as Record<string, unknown>;
    expect(autoImage.capabilities).toMatchObject({
      output_modalities: ['image'],
      supported_endpoints: ['/v1/images/generations'],
      synthetic: true,
    });
    expect(autoImage.capabilities).not.toHaveProperty('context_window');
    expect(autoImage.capabilities).not.toHaveProperty('max_output_tokens');
  });

  it('filters media models in one call', async () => {
    const res = await bearer(api().get('/v1/models?capabilities=true&output=image')).expect(200);
    const ids = (res.body.data as { id: string }[]).map((entry) => entry.id);

    expect(ids).toContain(`agnes/${IMAGE_MODEL}`);
    // The image tier is an image model too.
    expect(ids).toContain('auto-image');
    expect(ids).not.toContain(`agnes/${CHAT_MODEL}`);
    // The untiered router has no known output, so it is not claimed as image.
    expect(ids).not.toContain('auto');
  });

  it('serves a single model by the id the list published', async () => {
    const res = await bearer(api().get(`/v1/models/agnes/${CHAT_MODEL}?capabilities=true`)).expect(
      200,
    );

    expect(res.body.id).toBe(`agnes/${CHAT_MODEL}`);
    expect(res.body.capabilities.context_window).toBe(524_288);

    await bearer(api().get('/v1/models/agnes/ghost')).expect(404);
  });

  it('routes a listed model without M302 for the same agent key', async () => {
    const res = await bearer(api().post('/v1/images/generations')).send({
      model: `agnes/${IMAGE_MODEL}`,
      prompt: 'a cat',
    });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('M302');
  });

  it('produces the same upstream body for extra_body.image and top-level image', async () => {
    upstreamBodies.length = 0;

    await bearer(api().post('/v1/images/generations'))
      .send({
        model: `agnes/${IMAGE_MODEL}`,
        prompt: 'a cat',
        response_format: 'b64_json',
        image: 'https://example.com/ref.png',
      })
      .expect(200);

    await bearer(api().post('/v1/images/generations'))
      .send({
        model: `agnes/${IMAGE_MODEL}`,
        prompt: 'a cat',
        extra_body: {
          response_format: 'b64_json',
          image: 'https://example.com/ref.png',
        },
      })
      .expect(200);

    expect(upstreamBodies).toHaveLength(2);
    expect(upstreamBodies[1].body).toEqual(upstreamBodies[0].body);
    expect(upstreamBodies[0].body).toMatchObject({
      extra_body: {
        response_format: 'b64_json',
        image: ['https://example.com/ref.png'],
      },
    });
  });
});
