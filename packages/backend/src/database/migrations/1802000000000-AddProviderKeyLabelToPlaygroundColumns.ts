import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persists which provider API key label was used for each playground column run.
 */
export class AddProviderKeyLabelToPlaygroundColumns1802000000000 implements MigrationInterface {
  name = 'AddProviderKeyLabelToPlaygroundColumns1802000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(
      `ALTER TABLE "playground_columns" ADD COLUMN IF NOT EXISTS "provider_key_label" varchar DEFAULT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(
      `ALTER TABLE "playground_columns" DROP COLUMN IF EXISTS "provider_key_label"`,
    );
  }
}
