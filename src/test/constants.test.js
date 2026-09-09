/**
 * constants.js 单元测试
 */

const { TASK_STATES } = require('../core/constants');

describe('constants', () => {
  describe('TASK_STATES', () => {
    test('should contain core states', () => {
      expect(TASK_STATES.TRIAGE).toBeDefined();
      expect(TASK_STATES.TODO).toBeDefined();
      expect(TASK_STATES.CLAIMED).toBeDefined();
      expect(TASK_STATES.RUNNING).toBeDefined();
      expect(TASK_STATES.DONE).toBeDefined();
      expect(TASK_STATES.BLOCKED).toBeDefined();
      expect(TASK_STATES.FAILED).toBeDefined();
    });

    test('status values should be strings', () => {
      // eslint-disable-next-line no-unused-vars
      for (const [key, value] of Object.entries(TASK_STATES)) {
        expect(typeof value).toBe('string');
      }
    });

    test('status values should be unique', () => {
      const values = Object.values(TASK_STATES);
      const uniqueValues = new Set(values);
      expect(values.length).toBe(uniqueValues.size);
    });
  });
});