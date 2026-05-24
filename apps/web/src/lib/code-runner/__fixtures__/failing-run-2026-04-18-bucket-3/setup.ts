import { vi } from 'vitest';

vi.mock('../api', () => ({
  fetchUser: vi.fn() {
    return Promise.resolve({ id: 1, name: 'Ada' });
  },
}));
