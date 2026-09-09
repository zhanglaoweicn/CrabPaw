const { parseStationCodes, formatTrainsSpeech, loadStationCodes } = require('../../src/tools/train-tools');

module.exports = {
  name: 'Train Tools',
  cases: [
    {
      id: 'tt_001',
      name: '站点码表解析：中文站名→电报码',
      category: 'train_tools',
      run: () => {
        const map = parseStationCodes('@beijing|北京|BJP|beijing|bj|0@shanghai|上海|SHH|shanghai|sh|1@hangzhou|杭州|HZH|hangzhou|hz|1');
        return map.get('北京') === 'BJP' && map.get('上海') === 'SHH' && map.get('杭州') === 'HZH';
      },
    },
    {
      id: 'tt_002',
      name: '站点码表含空段时解析不崩溃',
      category: 'train_tools',
      run: () => {
        const map = parseStationCodes('@beijing|北京|BJP|beijing|bj|0@|||@shanghai|上海|SHH|shanghai|sh|1');
        return map.get('北京') === 'BJP' && map.get('上海') === 'SHH';
      },
    },
    {
      id: 'tt_003',
      name: '播报文本：前 3 班车次口语化',
      category: 'train_tools',
      run: () => {
        const trains = [
          { code: 'G101', from: '北京', to: '上海', depart: '07:00', arrive: '11:29', duration: '4小时29分', seats: [{ name: '二等座', count: '有' }, { name: '一等座', count: '3' }] },
          { code: 'G103', from: '北京', to: '上海', depart: '07:36', arrive: '12:15', duration: '4小时39分', seats: [{ name: '二等座', count: '无' }] },
        ];
        const t = formatTrainsSpeech(trains);
        return t.includes('G101') && t.includes('G103') && t.includes('二等座') && !t.includes('G104');
      },
    },
    {
      id: 'tt_004',
      name: '无车次时降级提示',
      category: 'train_tools',
      run: () => formatTrainsSpeech([]).includes('建议'),
    },
    {
      id: 'tt_005',
      name: 'TrainQuery 契约：from/to/date 必填',
      category: 'train_tools',
      run: () => {
        const { validateToolInput } = require('../../src/core/tool-contract');
        const missing = validateToolInput('TrainQuery', { from: '北京', to: '上海' });
        const ok = validateToolInput('TrainQuery', { from: '北京', to: '上海', date: '2026-08-10' });
        return !missing.valid && ok.valid;
      },
    },
    {
      id: 'tt_006',
      name: '站点码表缓存可加载（空表不崩溃）',
      category: 'train_tools',
      run: async () => {
        const map = await loadStationCodes();
        return map instanceof Map && map.size >= 0;
      },
    },
  ],
};
