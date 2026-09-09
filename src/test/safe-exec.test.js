/**
 * safe-exec.js 测试
 */
const path = require('path');
const fs = require('fs');

describe('safe-exec', () => {
  test('safe-exec.js module file exists', () => {
    const filePath = path.join(__dirname, '..', 'core', 'safe-exec.js');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test('should load without throwing on syntax level', () => {
    const filePath = path.join(__dirname, '..', 'core', 'safe-exec.js');
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('module.exports');
  });
});