import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persist the provider task id of an asynchronous video generation on its
 * Manifest Request. `GET /v1/videos/{id}` looks the request up by
 * (tenant_id, media_task_id) to re-select the same provider connection and
 * finalize the per-second cost once the task completes.
 */
export class AddRequestMediaTaskId1803200000000 implements MigrationInterface {
  name = 'AddRequestMediaTaskId1803200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.withBoundedLockWait(queryRunner, async () => {
      await queryRunner.query(`
        ALTER TABLE "requests"
          ADD COLUMN IF NOT EXISTS "media_task_id" character varying
      `);
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "IDX_requests_tenant_media_task"
          ON "requests" ("tenant_id", "media_task_id")
      `);
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.withBoundedLockWait(queryRunner, async () => {
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_requests_tenant_media_task"`);
      await queryRunner.query(`
        ALTER TABLE "requests"
          DROP COLUMN IF EXISTS "media_task_id"
      `);
    });
  }

  private async withBoundedLockWait(
    queryRunner: QueryRunner,
    change: () => Promise<void>,
  ): Promise<void> {
    if (queryRunner.isTransactionActive) {
      await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
      await change();
      return;
    }

    await queryRunner.query(`SET lock_timeout = '5s'`);
    try {
      await change();
    } finally {
      await queryRunner.query(`RESET lock_timeout`);
    }
  }
}
