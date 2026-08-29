import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DreoAPI from '../src/DreoAPI';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const log = {
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

function createApi(): DreoAPI {
  return new DreoAPI({
    config: { options: { email: 'fan@example.com', password: 'secret' } },
    log,
  } as never);
}

describe('Dreo REST authentication refresh', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('serializes one authentication refresh and retries concurrent unauthorized state reads', async () => {
    vi.mocked(axios.get)
      .mockRejectedValueOnce({ response: { status: 401 }, message: 'unauthorized' })
      .mockRejectedValueOnce({ response: { status: 401 }, message: 'unauthorized' })
      .mockResolvedValueOnce({ data: { data: { mixed: { poweron: { state: true } } } } })
      .mockResolvedValueOnce({ data: { data: { mixed: { poweron: { state: false } } } } });
    vi.mocked(axios.post).mockResolvedValue({
      data: { data: { access_token: 'refreshed-token' } },
    });
    const api = createApi();

    const states = await Promise.all([api.getState('fan-1'), api.getState('fan-2')]);

    expect(states).toEqual([
      { poweron: { state: true } },
      { poweron: { state: false } },
    ]);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledTimes(4);
    expect(vi.mocked(axios.get).mock.calls[2]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer refreshed-token',
    });
  });
});
