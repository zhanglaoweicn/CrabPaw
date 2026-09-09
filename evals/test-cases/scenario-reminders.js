const { fetchWeatherForecast } = require('../../src/core/weather-forecast');
const { evaluateScenarios } = require('../../src/core/proactive/scenario-reminder-engine');

module.exports = {
  name: 'Scenario Reminders',
  cases: [
    {
      id: 'sr_001',
      name: '6h 降雨≥2mm 且 6h 内有外出日程 → weather_exit',
      category: 'scenario_reminders',
      run: () => {
        const hits = evaluateScenarios({
          weather: { next6hMaxPrecipMm: 8 },
          schedules: [{ start: '2026-08-07T14:00:00', title: '供应商会议' }],
          now: '2026-08-07T10:00:00',
        });
        return hits.some((h) => h.ruleId === 'weather_exit' && h.text.includes('伞'));
      },
    },
    {
      id: 'sr_002',
      name: '有雨但无外出日程 → 不触发 weather_exit',
      category: 'scenario_reminders',
      run: () => {
        const hits = evaluateScenarios({ weather: { next6hMaxPrecipMm: 10 }, schedules: [], now: '2026-08-07T10:00:00' });
        return !hits.some((h) => h.ruleId === 'weather_exit');
      },
    },
    {
      id: 'sr_003',
      name: '日程前 40 分钟 → meeting_departure',
      category: 'scenario_reminders',
      run: () => {
        const hits = evaluateScenarios({
          weather: null,
          schedules: [{ start: '2026-08-07T11:00:00', title: '董事会' }],
          now: '2026-08-07T10:20:00',
        });
        return hits.some((h) => h.ruleId === 'meeting_departure' && h.text.includes('董事会'));
      },
    },
    {
      id: 'sr_004',
      name: '征期截止日前 1 天 → tax_deadline',
      category: 'scenario_reminders',
      run: () => {
        const hits = evaluateScenarios({ weather: null, schedules: [], now: '2026-08-14T17:00:00' });
        return hits.some((h) => h.ruleId === 'tax_deadline' && h.text.includes('报税'));
      },
    },
    {
      id: 'sr_005',
      name: '年报期（4 月）→ license_renewal',
      category: 'scenario_reminders',
      run: () => {
        const hits = evaluateScenarios({ weather: null, schedules: [], now: '2026-04-10T09:00:00' });
        return hits.some((h) => h.ruleId === 'license_renewal');
      },
    },
    {
      id: 'sr_006',
      name: '节假日前一天 → holiday_eve',
      category: 'scenario_reminders',
      run: () => {
        const hits = evaluateScenarios({ weather: null, schedules: [], now: '2026-10-01T09:00:00' });
        return hits.some((h) => h.ruleId === 'holiday_eve');
      },
    },
    {
      id: 'sr_007',
      name: '工作日无风险时零触发（不打扰）',
      category: 'scenario_reminders',
      run: () => {
        const hits = evaluateScenarios({ weather: { next6hMaxPrecipMm: 0 }, schedules: [], now: '2026-08-10T15:00:00', holdings: [] });
        return hits.filter((h) => !['stock_preopen'].includes(h.ruleId)).length === 0;
      },
    },
    {
      id: 'sr_008',
      name: '天气预报解析：逐小时降雨 → 6h 最大降雨',
      category: 'scenario_reminders',
      run: async () => {
        const fake = async () => ({
          hourly: [
            { time: '2026-08-07T11:00', precipMm: 0.0 },
            { time: '2026-08-07T12:00', precipMm: 3.5 },
            { time: '2026-08-07T13:00', precipMm: 5.0 },
          ],
        });
        const r = await fetchWeatherForecast('上海', { fetchFn: fake });
        return r.next6hMaxPrecipMm === 5.0 && r.hourly.length === 3;
      },
    },
  ],
};
