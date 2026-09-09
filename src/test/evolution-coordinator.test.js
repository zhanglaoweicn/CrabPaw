const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  EvolutionCoordinator,
  TARGET_SYSTEMS,
} = require('../core/evolution/evolution-coordinator');

function _wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitFor(condition, timeoutMs = 2000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('Timed out waiting for coordinator state'));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('EvolutionCoordinator queue processing', () => {
  let dataDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-evo-'));
    process.env.CRABPAW_DATA_DIR = dataDir;
  });

  afterEach(() => {
    delete process.env.CRABPAW_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('completes a non-grayscale proposal and clears processing state', async () => {
    const coordinator = new EvolutionCoordinator({ maxConcurrent: 1, timeoutMs: 5000 });
    coordinator.registerEngine(TARGET_SYSTEMS.SKILL, {
      evolve: jest.fn().mockResolvedValue({ success: true }),
    });

    const completed = new Promise(resolve => {
      coordinator.once('proposal:completed', resolve);
    });

    await coordinator.submit(
      { name: 'skill-update' },
      { targetSystem: TARGET_SYSTEMS.SKILL, grayscaleEnabled: false }
    );

    await completed;
    await waitFor(() => coordinator._processing === false);

    expect(coordinator._queue).toHaveLength(0);
    expect(coordinator._running.size).toBe(0);
    expect(coordinator._processing).toBe(false);
  });

  test('does not busy-loop while a grayscale proposal is waiting for observation', async () => {
    const coordinator = new EvolutionCoordinator({ maxConcurrent: 1, timeoutMs: 5000 });
    coordinator._startGrayscaleObservation = jest.fn();
    coordinator.registerEngine(TARGET_SYSTEMS.SKILL, {
      evolve: jest.fn().mockResolvedValue({ success: true }),
    });

    const grayscaleStarted = new Promise(resolve => {
      coordinator.once('proposal:grayscale_started', resolve);
    });

    await coordinator.submit(
      { name: 'skill-grayscale' },
      { targetSystem: TARGET_SYSTEMS.SKILL, grayscaleEnabled: true }
    );

    await grayscaleStarted;
    await waitFor(() => coordinator._processing === false);

    expect(coordinator._startGrayscaleObservation).toHaveBeenCalledTimes(1);
    expect(coordinator._queue).toHaveLength(0);
    expect(coordinator._running.size).toBe(1);
    expect(coordinator._processing).toBe(false);
  });

  test('resumes a same-system proposal after the running proposal finishes', async () => {
    const coordinator = new EvolutionCoordinator({ maxConcurrent: 1, timeoutMs: 5000 });
    let releaseFirst;
    const engine = {
      evolve: jest.fn(proposal => {
        if (proposal.name === 'first') {
          return new Promise(resolve => {
            releaseFirst = resolve;
          });
        }
        return Promise.resolve({ success: true });
      }),
    };
    coordinator.registerEngine(TARGET_SYSTEMS.SKILL, engine);

    const firstStarted = new Promise(resolve => {
      coordinator.once('proposal:started', resolve);
    });
    let secondId;
    const secondCompleted = new Promise(resolve => {
      coordinator.on('proposal:completed', payload => {
        if (payload.id === secondId) resolve();
      });
    });

    const first = await coordinator.submit(
      { name: 'first' },
      { targetSystem: TARGET_SYSTEMS.SKILL, grayscaleEnabled: false }
    );
    await firstStarted;

    const second = await coordinator.submit(
      { name: 'second' },
      { targetSystem: TARGET_SYSTEMS.SKILL, grayscaleEnabled: false }
    );
    secondId = second.id;

    releaseFirst({ success: true });
    await secondCompleted;
    await waitFor(() => coordinator._processing === false);

    expect(coordinator._queue).toHaveLength(0);
    expect(coordinator._running.size).toBe(0);
    expect(engine.evolve).toHaveBeenCalledTimes(2);
    expect(coordinator._processing).toBe(false);
    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
  });
});
