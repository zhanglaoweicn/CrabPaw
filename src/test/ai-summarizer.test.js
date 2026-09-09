const { summarize } = require('../core/ai-summarizer');

describe('ai-summarizer', () => {
  const mockDeps = {
    getModelRouter: jest.fn(),
    createModelRouter: jest.fn(),
    fetchWithRetry: jest.fn(),
  };

  const mockConfig = { providers: [] };
  const mockResults = [
    { title: 'Test News 1', desc: 'Description 1' },
    { title: 'Test News 2', desc: 'Description 2' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when deps are missing', async () => {
    const result = await summarize(mockConfig, 'test', mockResults, '', {});
    expect(result).toBeNull();
  });

  it('returns null when router is not available', async () => {
    mockDeps.getModelRouter.mockReturnValue(null);
    mockDeps.createModelRouter.mockReturnValue(null);
    const result = await summarize(mockConfig, 'test', mockResults, '', mockDeps);
    expect(result).toBeNull();
    expect(mockDeps.createModelRouter).toHaveBeenCalledWith(mockConfig);
  });

  it('returns null when router route has error', async () => {
    const mockRouter = { route: jest.fn().mockReturnValue({ error: 'no route' }) };
    mockDeps.getModelRouter.mockReturnValue(mockRouter);
    const result = await summarize(mockConfig, 'test', mockResults, '', mockDeps);
    expect(result).toBeNull();
  });

  it('returns null when API call fails', async () => {
    const mockRouter = {
      route: jest.fn().mockReturnValue({
        model: 'test-model',
        baseUrl: 'https://api.test.com',
        apiKey: 'test-key',
        provider: 'test',
      }),
    };
    mockDeps.getModelRouter.mockReturnValue(mockRouter);
    mockDeps.fetchWithRetry.mockResolvedValue({
      ok: false,
      status: 500,
      text: jest.fn().mockResolvedValue('Internal Server Error'),
    });

    const result = await summarize(mockConfig, 'test', mockResults, '', mockDeps);
    expect(result).toBeNull();
  });

  it('returns null when API response has no choices', async () => {
    const mockRouter = {
      route: jest.fn().mockReturnValue({
        model: 'test-model',
        baseUrl: 'https://api.test.com',
        apiKey: 'test-key',
        provider: 'test',
      }),
    };
    mockDeps.getModelRouter.mockReturnValue(mockRouter);
    mockDeps.fetchWithRetry.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ choices: [] }),
    });

    const result = await summarize(mockConfig, 'test', mockResults, '', mockDeps);
    expect(result).toBeNull();
  });

  it('returns content on successful API call', async () => {
    const mockRouter = {
      route: jest.fn().mockReturnValue({
        model: 'test-model',
        baseUrl: 'https://api.test.com',
        apiKey: 'test-key',
        provider: 'test',
      }),
    };
    mockDeps.getModelRouter.mockReturnValue(mockRouter);
    mockDeps.fetchWithRetry.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        choices: [{ message: { content: '## 🔥 Test Summary' } }],
      }),
    });

    const result = await summarize(mockConfig, 'test', mockResults, '', mockDeps);
    expect(result).toBe('## 🔥 Test Summary');
  });

  it('uses customPrompt when provided', async () => {
    const mockRouter = {
      route: jest.fn().mockReturnValue({
        model: 'test-model',
        baseUrl: 'https://api.test.com',
        apiKey: 'test-key',
        provider: 'test',
      }),
    };
    mockDeps.getModelRouter.mockReturnValue(mockRouter);
    mockDeps.fetchWithRetry.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        choices: [{ message: { content: 'Custom Summary' } }],
      }),
    });

    const result = await summarize(mockConfig, 'test', mockResults, 'Custom prompt text', mockDeps);
    expect(result).toBe('Custom Summary');

    const callBody = JSON.parse(mockDeps.fetchWithRetry.mock.calls[0][1].body);
    expect(callBody.messages[0].content).toContain('Custom prompt text');
  });

  it('handles fetchWithRetry throwing an exception', async () => {
    const mockRouter = {
      route: jest.fn().mockReturnValue({
        model: 'test-model',
        baseUrl: 'https://api.test.com',
        apiKey: 'test-key',
        provider: 'test',
      }),
    };
    mockDeps.getModelRouter.mockReturnValue(mockRouter);
    mockDeps.fetchWithRetry.mockRejectedValue(new Error('Network error'));

    const result = await summarize(mockConfig, 'test', mockResults, '', mockDeps);
    expect(result).toBeNull();
  });
});
