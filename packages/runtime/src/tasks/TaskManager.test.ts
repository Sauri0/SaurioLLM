// Test de DefaultTaskManager (doc 05 §2.9 paso 35: task_update -> tasks + tasks.updated).
import { describe, expect, it } from 'vitest';
import { DefaultTaskManager } from './TaskManager.js';
import { makeFakeClock, makeFakeEventStore, makeFakeTaskRepository } from '../agent/testSupport.js';

describe('DefaultTaskManager', () => {
  it('update() persiste vía TaskRepository y emite tasks.updated', async () => {
    const events = makeFakeEventStore();
    const clock = makeFakeClock();
    const tasks = makeFakeTaskRepository();
    const manager = new DefaultTaskManager({ tasks, events, clock });

    const saved = await manager.update('chat_1', 'run_1', [
      { id: 't1', ord: 0, title: 'Leer el repo', status: 'done' },
      { id: 't2', ord: 1, title: 'Proponer el cambio', status: 'in_progress' },
    ]);

    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ chatId: 'chat_1', id: 't1', status: 'done' });

    const listed = await manager.list('chat_1');
    expect(listed).toEqual(saved);

    expect(events.all).toHaveLength(1);
    expect(events.all[0]).toMatchObject({ type: 'tasks.updated', runId: 'run_1', chatId: 'chat_1' });
  });

  it('list() de un chat sin tasks devuelve []', async () => {
    const manager = new DefaultTaskManager({
      tasks: makeFakeTaskRepository(), events: makeFakeEventStore(), clock: makeFakeClock(),
    });
    expect(await manager.list('chat_sin_tasks')).toEqual([]);
  });
});
