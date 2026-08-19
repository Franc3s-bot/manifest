import { AddProviderKeyLabelToPlaygroundColumns1802000000000 } from './1802000000000-AddProviderKeyLabelToPlaygroundColumns';

describe('AddProviderKeyLabelToPlaygroundColumns1802000000000', () => {
  const migration = new AddProviderKeyLabelToPlaygroundColumns1802000000000();
  const query = jest.fn().mockResolvedValue([]);
  const queryRunner = { query } as never;

  beforeEach(() => jest.clearAllMocks());

  it('adds the nullable provider_key_label column to playground_columns', async () => {
    await migration.up(queryRunner);

    expect(query).toHaveBeenCalledTimes(2);
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements[0]).toContain("SET LOCAL lock_timeout = '5s'");
    expect(statements[1]).toContain('ALTER TABLE "playground_columns"');
    expect(statements[1]).toContain('ADD COLUMN IF NOT EXISTS "provider_key_label"');
  });

  it('drops the column on rollback', async () => {
    await migration.down(queryRunner);

    expect(query).toHaveBeenCalledTimes(2);
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements[0]).toContain("SET LOCAL lock_timeout = '5s'");
    expect(statements[1]).toContain('ALTER TABLE "playground_columns"');
    expect(statements[1]).toContain('DROP COLUMN IF EXISTS "provider_key_label"');
  });
});
