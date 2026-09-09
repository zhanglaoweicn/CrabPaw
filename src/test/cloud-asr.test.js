/**
 * cloud-asr.js 纯函数单元测试
 *
 * 覆盖火山引擎二进制帧编解码、Aliyun Key 校验、emitVolcTranscripts 语义层。
 * 不测试 WebSocket 网络层（需 mock），只测试纯函数的输入→输出映射。
 */

const {
  isValidAliyunAsrKey,
  _classifyASRError,
  _attachErrorCategory,
  _makeVolcHeader,
  _makeVolcFrame,
  _makeVolcFullClientRequest,
  _makeVolcAudioFrame,
  _parseVolcResponse,
  _emitVolcTranscripts,
} = require('../core/asr/cloud-asr');

// ─── 错误结构化分类（2026-08-14 fix）────────────────────
describe('classifyASRError / attachErrorCategory', () => {
  test('401/403/鉴权类 → auth', () => {
    expect(_classifyASRError(new Error('Unexpected server response: 403'))).toBe('auth');
    expect(_classifyASRError({ message: 'unauthorized: invalid token', code: 401 })).toBe('auth');
    expect(_classifyASRError('火山 ASR 错误 403: resource unavailable')).toBe('auth');
  });

  test('429/限流类 → rate', () => {
    expect(_classifyASRError({ message: '请求过于频繁', code: 429 })).toBe('rate');
    expect(_classifyASRError(new Error('rate limit exceeded'))).toBe('rate');
  });

  test('断线/超时类 → network', () => {
    expect(_classifyASRError(new Error('read ECONNRESET'))).toBe('network');
    expect(_classifyASRError(new Error('socket hang up timeout'))).toBe('network');
    expect(_classifyASRError('网络错误: ETIMEDOUT')).toBe('network');
  });

  test('其余 → other', () => {
    expect(_classifyASRError(new Error('some unknown failure'))).toBe('other');
    expect(_classifyASRError('阿里云 ASR 错误')).toBe('other');
    expect(_classifyASRError(null)).toBe('other');
  });

  test('attachErrorCategory 给 Error 对象附加 category', () => {
    const err = new Error('read ECONNRESET');
    const out = _attachErrorCategory(err);
    expect(out).toBe(err); // 可写对象直接附加并返回原对象
    expect(out.category).toBe('network');
    expect(out.message).toBe('read ECONNRESET');
  });

  test('attachErrorCategory 字符串输入包成 {message, category}', () => {
    const out = _attachErrorCategory('火山 ASR 错误 403: denied');
    expect(out).toEqual({ message: '火山 ASR 错误 403: denied', category: 'auth' });
  });

  test('attachErrorCategory 带 code 的纯对象按 code 分类', () => {
    const out = _attachErrorCategory({ message: '腾讯云 ASR 错误: over quota', code: 429 });
    expect(out.category).toBe('rate');
  });
});

// ─── isValidAliyunAsrKey ────────────────────────────────
describe('isValidAliyunAsrKey', () => {
  test('合法 sk- 开头 Key 通过', () => {
    expect(isValidAliyunAsrKey('sk-abcdefghijklmnopqrstuvwxyz123456')).toBe(true);
  });

  test('空值拒绝', () => {
    expect(isValidAliyunAsrKey('')).toBe(false);
    expect(isValidAliyunAsrKey(null)).toBe(false);
    expect(isValidAliyunAsrKey(undefined)).toBe(false);
  });

  test('非 sk- 前缀拒绝', () => {
    expect(isValidAliyunAsrKey('ak-abcdefghijklmnopqrstuvwxyz123456')).toBe(false);
    expect(isValidAliyunAsrKey('abcdefghijklmnopqrstuvwxyz123456')).toBe(false);
  });

  test('太短拒绝（<20 字符后缀）', () => {
    expect(isValidAliyunAsrKey('sk-short')).toBe(false);
  });

  test('含空格自动 trim', () => {
    expect(isValidAliyunAsrKey('  sk-abcdefghijklmnopqrstuvwxyz123456  ')).toBe(true);
  });

  test('含合法特殊字符（_-.）通过', () => {
    expect(isValidAliyunAsrKey('sk-abc_def-ghi.jkl1234567890')).toBe(true);
  });
});

// ─── 火山引擎二进制帧编解码 ────────────────────────────
describe('Volcengine 二进制帧编解码', () => {
  // ── makeVolcHeader ──
  describe('makeVolcHeader', () => {
    test('生成 4 字节 header', () => {
      const header = _makeVolcHeader(0x1, 0x0, 0x1, 0x1);
      expect(header).toBeInstanceOf(Buffer);
      expect(header.length).toBe(4);
    });

    test('协议版本和 header size 编码正确', () => {
      const header = _makeVolcHeader(0x1, 0x0, 0x1, 0x1);
      // V2 fix: 修复了 Volc 协议版本常量提取
      // Byte 0: (VOLC_PROTOCOL_VERSION << 4) | VOLC_HEADER_SIZE = (0x1 << 4) | 0x1 = 0x11
      expect(header[0]).toBe(0x11);
    });

    test('消息类型和 flags 编码正确', () => {
      const header = _makeVolcHeader(0x2, 0x2, 0x0, 0x1);
      // Byte 1: (messageType << 4) | flags = (0x2 << 4) | 0x2 = 0x22
      expect(header[1]).toBe(0x22);
    });

    test('序列化和压缩编码正确', () => {
      const header = _makeVolcHeader(0x1, 0x0, 0x1, 0x1);
      // Byte 2: (serialization << 4) | compression = (0x1 << 4) | 0x1 = 0x11
      expect(header[2]).toBe(0x11);
    });

    test('Byte 3 保留位为 0', () => {
      const header = _makeVolcHeader(0x1, 0x0, 0x1, 0x1);
      expect(header[3]).toBe(0x00);
    });
  });

  // ── makeVolcFrame ──
  describe('makeVolcFrame', () => {
    test('生成 header(4) + size(4) + gzip body 结构', () => {
      const payload = Buffer.from('{"test":true}', 'utf-8');
      const frame = _makeVolcFrame(0x1, 0x0, 0x1, payload);
      // 结构：header(4) + size(4) + gzip body
      expect(frame.length).toBeGreaterThan(8);
      // size 字段（big-endian uint32）= gzip body 长度
      const size = frame.readUInt32BE(4);
      expect(size).toBeGreaterThan(0);
      // frame 总长 = 4 + 4 + size
      expect(frame.length).toBe(8 + size);
    });

    test('空 payload 生成有效帧', () => {
      const frame = _makeVolcFrame(0x2, 0x2, 0x0, null);
      expect(frame.length).toBeGreaterThanOrEqual(8);
      const size = frame.readUInt32BE(4);
      // gzip of empty = 8 bytes (gzip header), or alloc(0) = 8 bytes gzip
      expect(size).toBeGreaterThan(0);
    });
  });

  // ── makeVolcFullClientRequest ──
  describe('makeVolcFullClientRequest', () => {
    test('包含 JSON 配置（解压后可解析）', () => {
      const frame = _makeVolcFullClientRequest('zh');
      // 提取 body（跳过 header 4 + size 4）
      const size = frame.readUInt32BE(4);
      const gzipBody = frame.slice(8, 8 + size);
      const zlib = require('zlib');
      const json = JSON.parse(zlib.gunzipSync(gzipBody).toString('utf-8'));
      expect(json.user).toBeDefined();
      expect(json.audio).toBeDefined();
      expect(json.audio.format).toBe('pcm');
      expect(json.audio.rate).toBe(16000);
    });

    test('中文语言映射为 zh-CN', () => {
      const frame = _makeVolcFullClientRequest('zh');
      const size = frame.readUInt32BE(4);
      const zlib = require('zlib');
      const json = JSON.parse(zlib.gunzipSync(frame.slice(8, 8 + size)).toString('utf-8'));
      expect(json.audio.language).toBe('zh-CN');
    });

    test('英文语言保持原值', () => {
      const frame = _makeVolcFullClientRequest('en');
      const size = frame.readUInt32BE(4);
      const zlib = require('zlib');
      const json = JSON.parse(zlib.gunzipSync(frame.slice(8, 8 + size)).toString('utf-8'));
      expect(json.audio.language).toBe('en');
    });
  });

  // ── makeVolcAudioFrame ──
  describe('makeVolcAudioFrame', () => {
    test('PCM 数据被 gzip 压缩', () => {
      const pcm = Buffer.from(new Int16Array([100, -200, 300, -400]).buffer);
      const frame = _makeVolcAudioFrame(pcm, false);
      expect(frame[1] >> 4).toBe(0x2); // messageType = AUDIO_ONLY
      expect(frame[1] & 0x0f).toBe(0x0); // flags = NO_SEQUENCE
    });

    test('isLast=true 时 flags = LAST_NO_SEQUENCE (0x2)', () => {
      const pcm = Buffer.alloc(100);
      const frame = _makeVolcAudioFrame(pcm, true);
      expect(frame[1] & 0x0f).toBe(0x2);
    });

    test('isLast=false 时 flags = NO_SEQUENCE (0x0)', () => {
      const pcm = Buffer.alloc(100);
      const frame = _makeVolcAudioFrame(pcm, false);
      expect(frame[1] & 0x0f).toBe(0x0);
    });
  });

  // ── parseVolcResponse ──
  describe('parseVolcResponse', () => {
    test('空/短 buffer 返回 null', () => {
      expect(_parseVolcResponse(Buffer.alloc(0))).toBeNull();
      expect(_parseVolcResponse(Buffer.alloc(4))).toBeNull();
    });

    test('解析错误消息（messageType=0xf）', () => {
      // 构造错误帧: header(4) + errorCode(4) + errorMsgSize(4) + errorMsg
      const errMsg = Buffer.from('test error', 'utf-8');
      const buf = Buffer.alloc(4 + 4 + 4 + errMsg.length);
      buf[0] = 0x11; // protocol=1, headerSize=1
      buf[1] = 0xf0; // messageType=0xf (ERROR), flags=0
      buf[2] = 0x00; // serialization=0, compression=0
      buf[3] = 0x00;
      buf.writeUInt32BE(404, 4); // errorCode
      buf.writeUInt32BE(errMsg.length, 8); // errorMsgSize
      errMsg.copy(buf, 12);
      const result = _parseVolcResponse(buf);
      expect(result.error).toContain('404');
      expect(result.error).toContain('test error');
    });

    test('解析正常响应（含 utterances）', () => {
      const zlib = require('zlib');
      const bodyJson = {
        result: [{
          utterances: [
            { text: '你好', definite: true },
            { text: '世界', definite: false },
          ],
        }],
      };
      const gzipBody = zlib.gzipSync(Buffer.from(JSON.stringify(bodyJson), 'utf-8'));
      const buf = Buffer.alloc(8 + gzipBody.length);
      // headerSize = (buf[0] & 0x0f) * 4 = 1 * 4 = 4 bytes
      buf[0] = 0x11; // protocol=1, headerSize=1
      buf[1] = 0x90; // messageType=0x9 (FULL_SERVER_RESPONSE), flags=0
      buf[2] = 0x11; // serialization=JSON(1), compression=GZIP(1)
      buf[3] = 0x00;
      buf.writeUInt32BE(gzipBody.length, 4);
      gzipBody.copy(buf, 8);
      const result = _parseVolcResponse(buf);
      expect(result).not.toBeNull();
      expect(result.body.result[0].utterances).toHaveLength(2);
      expect(result.isLast).toBe(false);
    });

    test('flags=0x3 时 isLast=true', () => {
      const zlib = require('zlib');
      const bodyJson = { result: [{ text: 'done' }] };
      const gzipBody = zlib.gzipSync(Buffer.from(JSON.stringify(bodyJson), 'utf-8'));
      // flags=0x3 时解析器在 size 前跳过 4 字节序列号
      // 结构：header(4) + seq(4) + size(4) + gzipBody
      const buf = Buffer.alloc(12 + gzipBody.length);
      buf[0] = 0x11; // protocol=1, headerSize=1
      buf[1] = 0x93; // messageType=0x9, flags=0x3 (isLast + has sequence)
      buf[2] = 0x11; // serialization=JSON(1), compression=GZIP(1)
      buf[3] = 0x00;
      // offset 4-7: 序列号（解析器跳过）
      buf.writeUInt32BE(0, 4);
      // offset 8-11: payload size
      buf.writeUInt32BE(gzipBody.length, 8);
      gzipBody.copy(buf, 12);
      const result = _parseVolcResponse(buf);
      expect(result.isLast).toBe(true);
    });
  });
});

// ─── emitVolcTranscripts 语义层 ────────────────────────
describe('emitVolcTranscripts', () => {
  test('utterances 逐条下发，definite → isFinal=true', () => {
    const calls = [];
    const body = {
      result: [{
        utterances: [
          { text: '第一句', definite: true },
          { text: '第二句', definite: true },
          { text: '当前句', definite: false },
        ],
      }],
    };
    _emitVolcTranscripts(body, false, (text, isFinal, seg, speechFinal) => {
      calls.push({ text, isFinal, seg, speechFinal });
    }, 'session-1');
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ text: '第一句', isFinal: true, seg: 'vsession-1:0', speechFinal: false });
    expect(calls[1]).toEqual({ text: '第二句', isFinal: true, seg: 'vsession-1:1', speechFinal: false });
    expect(calls[2]).toEqual({ text: '当前句', isFinal: false, seg: 'vsession-1:2', speechFinal: false });
  });

  test('isLast=true 时最后一条 definite utterance 标记为 speechFinal', () => {
    const calls = [];
    const body = {
      result: [{
        utterances: [
          { text: '已完成句', definite: true },
          { text: '最终句', definite: true },
        ],
      }],
    };
    _emitVolcTranscripts(body, true, (text, isFinal, seg, speechFinal) => {
      calls.push({ text, isFinal, seg, speechFinal });
    }, 'session-2');
    expect(calls).toHaveLength(2);
    expect(calls[1].speechFinal).toBe(true); // 最后一条 definite → speechFinal
    expect(calls[0].speechFinal).toBe(false);
  });

  test('空 utterances 回退到整段 text', () => {
    const calls = [];
    const body = { result: [{ text: '整段文本' }] };
    _emitVolcTranscripts(body, true, (text, isFinal, seg, speechFinal) => {
      calls.push({ text, isFinal, seg, speechFinal });
    }, 'session-3');
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe('整段文本');
    expect(calls[0].isFinal).toBe(true);
    expect(calls[0].speechFinal).toBe(true);
  });

  test('空 body 不触发回调', () => {
    const calls = [];
    _emitVolcTranscripts(null, false, () => calls.push('x'), 'session-4');
    expect(calls).toHaveLength(0);
  });

  test('跳过空 text 的 utterance', () => {
    const calls = [];
    const body = {
      result: [{
        utterances: [
          { text: '', definite: true },
          { text: '有效句', definite: true },
          { text: null, definite: false },
        ],
      }],
    };
    _emitVolcTranscripts(body, false, (text) => calls.push(text), 'session-5');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('有效句');
  });
});
