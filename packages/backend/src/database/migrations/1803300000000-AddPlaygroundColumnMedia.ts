import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Playground media support: a column can now produce an image or a video
 * instead of only text, and remembers which concrete route served it (a
 * synthetic `auto-{tier}` request resolves to a real model at request time).
 *
 *   output_kind  `text` | `image` | `video` (defaults to `text`)
 *   media        generated image list / video task object
 *   route        { provider, model, tier, synthetic, requestedModel }
 */
export class AddPlaygroundColumnMedia1803300000000 implements MigrationInterface {
  name = 'AddPlaygroundColumnMedia1803300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.withBoundedLockWait(queryRunner, async () => {
      await queryRunner.query(`
        ALTER TABLE "playground_columns"
          ADD COLUMN IF NOT EXISTS "output_kind" character varying DEFAULT 'text',
          ADD COLUMN IF NOT EXISTS "media" jsonb,
          ADD COLUMN IF NOT EXISTS "route" jsonb
      `);
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.withBoundedLockWait(queryRunner, async () => {
      await queryRunner.query(`
        ALTER TABLE "playground_columns"
          DROP COLUMN IF EXISTS "output_kind",
          DROP COLUMN IF EXISTS "media",
          DROP COLUMN IF EXISTS "route"
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
