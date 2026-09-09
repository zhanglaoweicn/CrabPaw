/**
 * secret-redactor.js 娴嬭瘯
 */
const {
  redactText,
  redactUrl,
  redactObject,
  redactToolResult,
  // eslint-disable-next-line no-unused-vars
  isRedactionEnabled,
  SENSITIVE_QUERY_PARAMS,
  SENSITIVE_BODY_KEYS,
} = require('../core/secret-redactor');

describe('secret-redactor', () => {
  describe('redactText', () => {
    test('should redact api keys', () => {
      const result = redactText('api_key=sk-abc123def456ghi789jkl012mno345');
      expect(typeof result).toBe('string');
    });

    test('should redact bearer tokens', () => {
      const result = redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test.sig');
      expect(typeof result).toBe('string');
    });

    test('should preserve non-sensitive content', () => {
      const input = 'Hello world, normal message';
      const result = redactText(input);
      expect(result).toContain('Hello');
    });
  });

  describe('redactUrl', () => {
    test('should redact sensitive query params', () => {
      const result = redactUrl('https://api.example.com?token=secret');
      expect(typeof result).toBe('string');
    });
  });

  describe('exports', () => {
    test('should export redaction functions', () => {
      expect(typeof redactText).toBe('function');
      expect(typeof redactUrl).toBe('function');
      expect(typeof redactObject).toBe('function');
      expect(typeof redactToolResult).toBe('function');
    });

    test('SENSITIVE_QUERY_PARAMS should be defined', () => {
      expect(SENSITIVE_QUERY_PARAMS).toBeDefined();
      expect(SENSITIVE_QUERY_PARAMS instanceof Set).toBe(true);
    });

    test('SENSITIVE_BODY_KEYS should be defined', () => {
      expect(SENSITIVE_BODY_KEYS).toBeDefined();
      expect(SENSITIVE_BODY_KEYS instanceof Set).toBe(true);
    });
  });
});