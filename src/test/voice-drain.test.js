const { setDraining, isDraining, destroyVoiceCloudWS } = require('../handlers/voice-cloud-ws');

describe('voice-cloud-ws draining', () => {
  it('导出 setDraining/isDraining/destroyVoiceCloudWS', () => {
    expect(typeof setDraining).toBe('function');
    expect(typeof isDraining).toBe('function');
    expect(typeof destroyVoiceCloudWS).toBe('function');
  });
  it('draining 标志可切换', () => {
    setDraining(true);
    expect(isDraining()).toBe(true);
    setDraining(false);
    expect(isDraining()).toBe(false);
  });
  it('未 attach 时 destroy 安全(无异常)', () => {
    expect(() => destroyVoiceCloudWS()).not.toThrow();
  });
});
