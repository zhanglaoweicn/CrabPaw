/**
 * entity-extractor.test.js — pattern 实体抽取器（semantica NER 范式的零依赖版）
 */
const { extractEntities, setLLMExtractFn } = require('../core/memory/entity-extractor');

describe('entity-extractor pattern 抽取', () => {
  test('引号/书名号实体被提取', () => {
    expect(extractEntities('帮我分析"铁血丹心"和《红楼梦》的关系')).toEqual(['铁血丹心', '红楼梦']);
  });

  test('I2 回归：闭合符不开启新匹配（》后不误抽 的关系）', () => {
    expect(extractEntities('读完《活着》再看《红楼梦》的关系')).toEqual(['活着', '红楼梦']);
  });

  test('热词表命中', () => {
    expect(extractEntities('台风摩羯会影响明天出行吗', ['台风摩羯'])).toContain('台风摩羯');
  });

  test('去重保序且上限 20', () => {
    // 22 个互异双字词 + 1 个重复（红楼，落于第 10 位、截断边界内）：重复只算一次、保首遇序、截断到 20
    const text = '"铁血" "丹心" "红楼" "梦缘" "风云" "江湖" "侠客" "青衫" "白衣" "红楼" "剑客" "书生" "琴师" "画师" "药师" "铁匠" "木匠" "石匠" "渔夫" "猎人" "樵夫" "郎中" "道童"';
    const out = extractEntities(text);
    expect(out).toHaveLength(20);
    expect(new Set(out).size).toBe(out.length);
    expect(out).toEqual(['铁血', '丹心', '红楼', '梦缘', '风云', '江湖', '侠客', '青衫', '白衣', '剑客', '书生', '琴师', '画师', '药师', '铁匠', '木匠', '石匠', '渔夫', '猎人', '樵夫']);
    expect(out.filter((e) => e === '红楼')).toHaveLength(1);
  });

  test('无命中返回空数组', () => {
    expect(extractEntities('你好')).toEqual([]);
  });

  test('setLLMExtractFn 后优先走 LLM 路径', async () => {
    setLLMExtractFn(async (t) => ['LLM实体:' + t.slice(0, 2)]);
    try {
      expect(await extractEntities('某段文本')).toEqual(['LLM实体:某段']);
    } finally {
      setLLMExtractFn(null);
    }
  });
});
