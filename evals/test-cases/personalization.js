/**
 * Personalization Eval — preference extraction, profile management,
 * prompt fragment generation.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

module.exports = {
  name: 'Personalization',
  cases: [
    {
      id: 'pe_001',
      name: 'detects Chinese language preference',
      category: 'personalization',
      run: () => {
        const { PersonalizationEngine } = require('../../src/core/personalization/personalization-engine');
        const eng = new PersonalizationEngine({ storePath: path.join(os.tmpdir(), 'pe-test-1.json') });
        const extracted = eng.analyze('请用中文回答这个问题');
        try { fs.unlinkSync(path.join(os.tmpdir(), 'pe-test-1.json')); } catch (_) { console.warn('Failed to cleanup pe-test-1.json', _.message); }
        return extracted.language === 'zh-CN';
      },
    },
    {
      id: 'pe_002',
      name: 'detects concise tone preference',
      category: 'personalization',
      run: () => {
        const { PersonalizationEngine } = require('../../src/core/personalization/personalization-engine');
        const eng = new PersonalizationEngine({ storePath: path.join(os.tmpdir(), 'pe-test-2.json') });
        const extracted = eng.analyze('请简洁回答');
        try { fs.unlinkSync(path.join(os.tmpdir(), 'pe-test-2.json')); } catch (_) { console.warn('Failed to cleanup pe-test-2.json', _.message); }
        return extracted.tone === 'concise';
      },
    },
    {
      id: 'pe_003',
      name: 'generates prompt fragment with detected prefs',
      category: 'personalization',
      run: () => {
        const { PersonalizationEngine } = require('../../src/core/personalization/personalization-engine');
        const eng = new PersonalizationEngine({
          initialProfile: { language: 'zh-CN', tone: 'concise', format: 'markdown' },
          storePath: path.join(os.tmpdir(), 'pe-test-3.json'),
        });
        const frag = eng.toPromptFragment();
        try { fs.unlinkSync(path.join(os.tmpdir(), 'pe-test-3.json')); } catch (_) { console.warn('Failed to cleanup pe-test-3.json', _.message); }
        return frag.includes('Language: zh-CN') && frag.includes('Tone: concise') && frag.includes('Markdown');
      },
    },
    {
      id: 'pe_004',
      name: 'setIdentity stores name',
      category: 'personalization',
      run: () => {
        const { PersonalizationEngine } = require('../../src/core/personalization/personalization-engine');
        const eng = new PersonalizationEngine({ storePath: path.join(os.tmpdir(), 'pe-test-4.json') });
        eng.setIdentity('TestUser', { expertise: ['JavaScript'] });
        const p = eng.getProfile();
        try { fs.unlinkSync(path.join(os.tmpdir(), 'pe-test-4.json')); } catch (_) { console.warn('Failed to cleanup pe-test-4.json', _.message); }
        return p.name === 'TestUser' && p.expertise.includes('JavaScript');
      },
    },
    {
      id: 'pe_005',
      name: 'persists and loads profile',
      category: 'personalization',
      run: () => {
        const storePath = path.join(os.tmpdir(), 'pe-test-5.json');
        try { fs.unlinkSync(storePath); } catch (_) { console.warn('Failed to cleanup storePath before pe_005', _.message); }
        const { PersonalizationEngine } = require('../../src/core/personalization/personalization-engine');
        const eng1 = new PersonalizationEngine({ storePath });
        eng1.analyze('用中文回答');
        const p1 = eng1.getProfile();
        const eng2 = new PersonalizationEngine({ storePath });
        const p2 = eng2.getProfile();
        try { fs.unlinkSync(storePath); } catch (_) { console.warn('Failed to cleanup storePath after pe_005', _.message); }
        return p2.language === 'zh-CN';
      },
    },
  ],
};
