/**
 * 示例插件 API 路由
 *
 * 导出 routes 对象，键格式为 "METHOD /path"
 * 值为异步处理函数 (req, ctx) => result
 */

const items = [
  { id: 1, name: '示例项目 A', status: 'active' },
  { id: 2, name: '示例项目 B', status: 'pending' },
  { id: 3, name: '示例项目 C', status: 'completed' },
];

module.exports.routes = {
  'GET /data': async (req, ctx) => {
    return {
      items,
      total: items.length,
      timestamp: Date.now(),
    };
  },

  'GET /data/:id': async (req, ctx) => {
    const id = parseInt(req.path.replace('/data/', ''), 10);
    const item = items.find(i => i.id === id);
    if (!item) {
      throw new Error(`项目 ${id} 不存在`);
    }
    return item;
  },

  'POST /data': async (req, ctx) => {
    const newItem = {
      id: items.length + 1,
      name: req.body.name || '新项目',
      status: req.body.status || 'pending',
    };
    items.push(newItem);
    return { created: newItem };
  },
};
