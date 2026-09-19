import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '../ipc/client.js';
import { useOllamaHealthStore } from './ollamaHealthStore.js';

vi.mock('../ipc/client.js', () => ({ invoke: vi.fn() }));
vi.mock('../demo/demoState.js', () => ({ isDemoMode: () => false }));

let unsubscribe: (() => void) | undefined;
afterEach(() => { unsubscribe?.(); unsubscribe = undefined; vi.clearAllMocks(); });

describe('salud del motor local', () => {
  it('no atribuye un error de nube a Ollama', async () => {
    vi.mocked(invoke).mockResolvedValue([
      { providerId: 'ollama', ok: true }, { providerId: 'api', ok: false },
    ]);
    unsubscribe = useOllamaHealthStore.getState().subscribe();
    await vi.waitFor(() => expect(useOllamaHealthStore.getState().ok).toBe(true));
  });

  it('no informa Ollama conectado si solo hay un proveedor API', async () => {
    useOllamaHealthStore.setState({ ok: null });
    vi.mocked(invoke).mockResolvedValue([{ providerId: 'api', ok: true }]);
    unsubscribe = useOllamaHealthStore.getState().subscribe();
    await vi.waitFor(() => expect(useOllamaHealthStore.getState().ok).toBe(false));
  });
});
