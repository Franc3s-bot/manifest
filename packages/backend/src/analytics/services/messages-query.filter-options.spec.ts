import { MessagesQueryService } from './messages-query.service';
import { computeCutoff } from '../../common/utils/postgres-sql';

/**
 * Filter options for the Requests log.
 *
 * The Model dropdown is built from the distinct-model scan over
 * `agent_messages`, which by construction cannot see a request Manifest blocked
 * before any provider call — that request has no attempt, and the log renders
 * its `requests.requested_model` in the Model column. Those models are folded
 * in separately so the dropdown can offer every value the column shows.
 */

function makeRequestQb(rows: Array<{ model: string }> = []) {
  const qb: Record<string, jest.Mock> = {
    select: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    getRawMany: jest.fn().mockResolvedValue(rows),
  };
  for (const name of ['select', 'where', 'andWhere']) qb[name].mockReturnValue(qb);
  return qb;
}

/** The attempt-side scan builder, used whenever the skip-scan fast path is off. */
function makeAttemptQb(rows: Array<{ model: string; provider?: string }> = []) {
  const qb: Record<string, jest.Mock> = {
    select: jest.fn(),
    addSelect: jest.fn(),
    distinct: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    getRawMany: jest.fn().mockResolvedValue(rows),
  };
  for (const name of ['select', 'addSelect', 'distinct', 'where', 'andWhere', 'orderBy'])
    qb[name].mockReturnValue(qb);
  return qb;
}

function makeService(opts: {
  attemptModels?: string[];
  blockedRows?: Array<{ model: string }>;
  withRequestRepo?: boolean;
  requestQb?: ReturnType<typeof makeRequestQb>;
}) {
  const turnRepo = {
    query: jest.fn().mockImplementation((sql: string) => {
      if (String(sql).includes('provider')) return Promise.resolve([]);
      return Promise.resolve((opts.attemptModels ?? []).map((model) => ({ model })));
    }),
    createQueryBuilder: jest.fn(() =>
      makeAttemptQb((opts.attemptModels ?? []).map((model) => ({ model }))),
    ),
  };
  const requestRepo =
    opts.withRequestRepo === false
      ? undefined
      : {
          createQueryBuilder: jest.fn(
            () => opts.requestQb ?? makeRequestQb(opts.blockedRows ?? []),
          ),
        };
  const service = new MessagesQueryService(
    turnRepo as never,
    { find: jest.fn().mockResolvedValue([]) } as never,
    requestRepo as never,
  );
  return { service, turnRepo, requestRepo };
}

describe('MessagesQueryService filter options', () => {
  it('offers models that only ever appeared on a request with no attempt', async () => {
    const { service } = makeService({
      attemptModels: ['gpt-4o'],
      blockedRows: [{ model: 'claude-3.5-sonnet' }],
    });

    const options = await service.getMessageFilterOptions({ tenantId: 'tenant-1', range: '24h' });

    expect(options.models).toEqual(['claude-3.5-sonnet', 'gpt-4o']);
  });

  it('lists each model once when a blocked request names one that also ran', async () => {
    const { service } = makeService({
      attemptModels: ['gpt-4o'],
      blockedRows: [{ model: 'gpt-4o' }],
    });

    const options = await service.getMessageFilterOptions({ tenantId: 'tenant-1', range: '24h' });

    expect(options.models).toEqual(['gpt-4o']);
  });

  it('scopes the blocked-model lookup to one harness when the caller names it', async () => {
    const requestQb = makeRequestQb([{ model: 'gpt-4o' }]);
    const { service } = makeService({ attemptModels: [], requestQb });

    await service.getMessageFilterOptions({
      tenantId: 'tenant-1',
      range: '24h',
      agent_name: 'bot-1',
    });

    const clauses = requestQb.andWhere.mock.calls.map((call) => String(call[0]));
    expect(clauses.some((clause) => clause.includes('r.agent_id = ('))).toBe(true);
    expect(clauses.some((clause) => clause.includes('r.tenant_id = :blockedTenantId'))).toBe(true);
    // The window comes from the caller's range, not the 90-day default: a
    // regression that ignored params.range would otherwise pass every test here.
    // Compared against the same formatter rather than an absolute clock
    // difference — computeCutoff emits local wall-clock with no zone, so a
    // re-parsed value is off by an hour across a DST fall-back.
    const cutoff = requestQb.where.mock.calls[0][1].cutoff as string;
    expect(cutoff > computeCutoff('90 days')).toBe(true);
  });

  it('defaults the blocked-model window when the caller gives no range', async () => {
    const requestQb = makeRequestQb([]);
    const { service } = makeService({ attemptModels: ['gpt-4o'], requestQb });

    await service.getMessageFilterOptions({ tenantId: 'tenant-1' });

    // Unbounded would mean a DISTINCT over the tenant's whole request history.
    expect(requestQb.where).toHaveBeenCalledWith(
      'r.timestamp >= :cutoff',
      expect.objectContaining({ cutoff: expect.anything() }),
    );
  });

  it('reuses the cached blocked-model list within the TTL', async () => {
    const requestQb = makeRequestQb([{ model: 'gpt-4o' }]);
    const { service, requestRepo } = makeService({ attemptModels: [], requestQb });

    await service.getMessageFilterOptions({ tenantId: 'tenant-1', range: '24h' });
    await service.getMessageFilterOptions({ tenantId: 'tenant-1', range: '24h' });

    expect(requestRepo!.createQueryBuilder).toHaveBeenCalledTimes(1);
  });

  it('returns no blocked models when the caller has no tenant', async () => {
    const requestQb = makeRequestQb([{ model: 'should-not-be-read' }]);
    const { service } = makeService({ attemptModels: [], requestQb });

    const options = await service.getMessageFilterOptions({ tenantId: null });

    expect(options.models).toEqual([]);
    expect(requestQb.getRawMany).not.toHaveBeenCalled();
  });

  it('skips the blocked-model lookup on an install with no requests table wired', async () => {
    const { service } = makeService({ attemptModels: ['gpt-4o'], withRequestRepo: false });

    const options = await service.getMessageFilterOptions({ tenantId: 'tenant-1', range: '24h' });

    expect(options.models).toEqual(['gpt-4o']);
  });
});
