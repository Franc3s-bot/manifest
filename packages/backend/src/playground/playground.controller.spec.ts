import { Test, type TestingModule } from '@nestjs/testing';
import type { Response as ExpressResponse } from 'express';
import { PlaygroundController } from './playground.controller';
import { PlaygroundService } from './playground.service';
import { PlaygroundHistoryService } from './playground-history.service';
import { PlaygroundAgentService } from './playground-agent.service';
import type { TenantContext } from '../common/decorators/tenant-context.decorator';
import type { RunPlaygroundDto } from './dto/run-playground.dto';

const CTX: TenantContext = { tenantId: 'tenant-1', userId: 'user-1' };

const AGENT = { id: 'agent-1', tenant_id: 'tenant-1', name: 'Playground' };

describe('PlaygroundController', () => {
  let controller: PlaygroundController;
  let runStream: jest.Mock;
  let listModels: jest.Mock;
  let videoStatus: jest.Mock;
  let listRuns: jest.Mock;
  let getRun: jest.Mock;
  let toggleStar: jest.Mock;
  let setBestColumn: jest.Mock;
  let deleteRun: jest.Mock;
  let deleteColumn: jest.Mock;
  let renameRun: jest.Mock;
  let playgroundAgentResolve: jest.Mock;

  beforeEach(async () => {
    runStream = jest.fn();
    listModels = jest.fn();
    videoStatus = jest.fn();
    listRuns = jest.fn();
    getRun = jest.fn();
    toggleStar = jest.fn();
    setBestColumn = jest.fn();
    deleteRun = jest.fn();
    deleteColumn = jest.fn();
    renameRun = jest.fn();
    playgroundAgentResolve = jest.fn().mockResolvedValue(AGENT);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PlaygroundController],
      providers: [
        { provide: PlaygroundService, useValue: { runStream, listModels, videoStatus } },
        {
          provide: PlaygroundHistoryService,
          useValue: {
            listRuns,
            getRun,
            toggleStar,
            setBestColumn,
            deleteRun,
            deleteColumn,
            renameRun,
          },
        },
        {
          provide: PlaygroundAgentService,
          useValue: { resolve: playgroundAgentResolve },
        },
      ],
    }).compile();

    controller = module.get(PlaygroundController);
  });

  describe('POST /playground/run', () => {
    it('delegates to PlaygroundService.runStream with the tenant context, dto and response', async () => {
      const dto = {
        model: 'openai/gpt-4o-mini',
        provider: 'openai',
        messages: [{ role: 'user', content: 'hi' }],
      } as unknown as RunPlaygroundDto;
      const res = {} as ExpressResponse;
      runStream.mockResolvedValue(undefined);

      const out = await controller.run(CTX, dto, res);

      expect(runStream).toHaveBeenCalledWith(CTX, dto, res);
      expect(out).toBeUndefined();
    });
  });

  describe('GET /playground/runs', () => {
    it('resolves the agent first then forwards its tenant+agent to listRuns', async () => {
      listRuns.mockResolvedValue([
        { id: 'r1', prompt: 'p', createdAt: 'now', modelCount: 1, models: ['m'] },
      ]);

      const out = await controller.listRuns(CTX);

      expect(playgroundAgentResolve).toHaveBeenCalledWith(CTX);
      expect(listRuns).toHaveBeenCalledWith('tenant-1', 'agent-1');
      expect(out).toHaveLength(1);
    });
  });

  describe('GET /playground/runs/:runId', () => {
    it('passes the resolved tenant+agentId through to the history lookup', async () => {
      getRun.mockResolvedValue({
        id: 'r1',
        prompt: 'p',
        createdAt: 'now',
        modelCount: 0,
        models: [],
        columns: [],
      });

      const out = await controller.getRun(CTX, { runId: 'r1' });

      expect(playgroundAgentResolve).toHaveBeenCalledWith(CTX);
      expect(getRun).toHaveBeenCalledWith('tenant-1', 'r1', 'agent-1');
      expect(out.id).toBe('r1');
    });

    it('propagates errors from the history service', async () => {
      const err = new Error('not found');
      getRun.mockRejectedValue(err);
      await expect(controller.getRun(CTX, { runId: 'r1' })).rejects.toBe(err);
    });
  });

  describe('PATCH /playground/runs/:runId/star', () => {
    it('toggles the star and returns the new value', async () => {
      toggleStar.mockResolvedValue(true);

      const out = await controller.toggleStar(CTX, { runId: 'r1' });

      expect(toggleStar).toHaveBeenCalledWith('tenant-1', 'r1');
      expect(out).toEqual({ starred: true });
    });
  });

  describe('PATCH /playground/runs/:runId/best', () => {
    it('sets the best column and returns the resolved id', async () => {
      setBestColumn.mockResolvedValue('col-9');

      const out = await controller.setBest(CTX, { runId: 'r1' }, { columnId: 'col-9' });

      expect(setBestColumn).toHaveBeenCalledWith('tenant-1', 'r1', 'col-9');
      expect(out).toEqual({ bestColumnId: 'col-9' });
    });

    it('clears the best column when columnId is null', async () => {
      setBestColumn.mockResolvedValue(null);

      const out = await controller.setBest(CTX, { runId: 'r1' }, { columnId: null });

      expect(setBestColumn).toHaveBeenCalledWith('tenant-1', 'r1', null);
      expect(out).toEqual({ bestColumnId: null });
    });

    it('propagates NotFound from the history service', async () => {
      const err = new Error('cross-run');
      setBestColumn.mockRejectedValue(err);
      await expect(controller.setBest(CTX, { runId: 'r1' }, { columnId: 'bad' })).rejects.toBe(err);
    });
  });

  describe('GET /playground/models', () => {
    it('delegates to PlaygroundService.listModels', async () => {
      listModels.mockResolvedValue([{ model_name: 'auto-standard', synthetic: true }]);
      const out = await controller.listModels(CTX);
      expect(listModels).toHaveBeenCalledWith(CTX);
      expect(out).toHaveLength(1);
    });
  });

  describe('GET /playground/videos/:taskId', () => {
    it('forwards the task id and optional column id', async () => {
      videoStatus.mockResolvedValue({ status: 200, media: { kind: 'video' }, costUsd: null });
      const out = await controller.videoStatus(CTX, 'task-1', 'col-1');
      expect(videoStatus).toHaveBeenCalledWith(CTX, 'task-1', 'col-1');
      expect(out.status).toBe(200);
    });
  });

  describe('PATCH /playground/runs/:runId', () => {
    it('renames the run via the resolved agent', async () => {
      renameRun.mockResolvedValue({ prompt: 'new title' });
      const out = await controller.renameRun(CTX, { runId: 'r1' }, { prompt: 'new title' });
      expect(renameRun).toHaveBeenCalledWith('tenant-1', 'agent-1', 'r1', 'new title');
      expect(out).toEqual({ prompt: 'new title' });
    });
  });

  describe('DELETE /playground/runs/:runId', () => {
    it('deletes the run via the resolved agent', async () => {
      deleteRun.mockResolvedValue({ deleted: true });
      const out = await controller.deleteRun(CTX, { runId: 'r1' });
      expect(deleteRun).toHaveBeenCalledWith('tenant-1', 'agent-1', 'r1');
      expect(out).toEqual({ deleted: true });
    });
  });

  describe('DELETE /playground/runs/:runId/columns/:columnId', () => {
    it('deletes the column via the resolved agent', async () => {
      deleteColumn.mockResolvedValue({ deleted: true, runDeleted: false });
      const out = await controller.deleteColumn(CTX, { runId: 'r1', columnId: 'col-1' });
      expect(deleteColumn).toHaveBeenCalledWith('tenant-1', 'agent-1', 'col-1');
      expect(out).toEqual({ deleted: true, runDeleted: false });
    });
  });
});
