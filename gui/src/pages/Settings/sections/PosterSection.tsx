import { useEffect, useState } from 'react'
import { apiGet, apiPost } from '../../../lib/api'

/**
 * PosterSection — 品牌资产包设置（2026-09-08 P1）
 * 数据通道：GET/POST /api/poster/brand-kit（与 PosterBrandKit 工具同源 brand-kit.json）
 * 保存即生效：后续所有海报自动携带品牌一致性。
 */
export function PosterSection({ activeSection }: { activeSection: string }) {
  const [kit, setKit] = useState({
    companyName: '', slogan: '', phone: '', address: '', wechat: '', accent: '#38bdf8',
  })
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!loaded) {
      apiGet('/api/poster/brand-kit').then((res: any) => {
        const d = res?.data || {}
        setKit({
          companyName: d.companyName || '',
          slogan: d.slogan || '',
          phone: d.contact?.phone || '',
          address: d.contact?.address || '',
          wechat: d.contact?.wechat || '',
          accent: d.colors?.primary || '#38bdf8',
        })
        setLoaded(true)
      }).catch((e: any) => setError('加载失败: ' + (e?.message || '')))
    }
  }, [loaded])

  const save = async () => {
    setError('')
    try {
      const res: any = await apiPost('/api/poster/brand-kit', {
        companyName: kit.companyName,
        slogan: kit.slogan,
        contact: { phone: kit.phone, address: kit.address, wechat: kit.wechat },
        colors: { primary: kit.accent },
      })
      if (res?.success) setSaved('已保存 ✓')
      else setError(res?.error || '保存失败')
    } catch (e: any) {
      setError(e?.message || '保存失败')
    }
  }

  return (
    <div className="theme-card p-6" style={{ display: activeSection === 'poster' ? 'block' : 'none' }}>
      <h3 className="font-medium mb-4 flex items-center gap-2 theme-text-primary">🖼️ 品牌资产包（海报）</h3>
      <p className="text-xs theme-text-muted mb-4">
        一次录入，之后所有生成的海报自动携带企业名称、口号与联系方式（营销海报的落款与品牌色）。
        也可以直接在对话里说"记住我的品牌：公司名XX，电话YY"。
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm mb-1 theme-text-secondary">企业名称</label>
          <input type="text" className="theme-input" value={kit.companyName}
            onChange={(e) => setKit(prev => ({ ...prev, companyName: e.target.value }))}
            placeholder="如：XX机械设备有限公司" />
        </div>
        <div>
          <label className="block text-sm mb-1 theme-text-secondary">品牌口号</label>
          <input type="text" className="theme-input" value={kit.slogan}
            onChange={(e) => setKit(prev => ({ ...prev, slogan: e.target.value }))}
            placeholder="如：二十年精密制造专家" />
        </div>
        <div>
          <label className="block text-sm mb-1 theme-text-secondary">联系电话</label>
          <input type="text" className="theme-input" value={kit.phone}
            onChange={(e) => setKit(prev => ({ ...prev, phone: e.target.value }))}
            placeholder="400-xxx-xxxx" />
        </div>
        <div>
          <label className="block text-sm mb-1 theme-text-secondary">微信号</label>
          <input type="text" className="theme-input" value={kit.wechat}
            onChange={(e) => setKit(prev => ({ ...prev, wechat: e.target.value }))} />
        </div>
        <div>
          <label className="block text-sm mb-1 theme-text-secondary">地址</label>
          <input type="text" className="theme-input" value={kit.address}
            onChange={(e) => setKit(prev => ({ ...prev, address: e.target.value }))} />
        </div>
        <div>
          <label className="block text-sm mb-1 theme-text-secondary">品牌主色（HEX）</label>
          <input type="text" className="theme-input" value={kit.accent}
            onChange={(e) => setKit(prev => ({ ...prev, accent: e.target.value }))}
            placeholder="#C8102E" />
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button type="button" className="theme-btn theme-btn-primary" onClick={save}>保存品牌包</button>
        {saved && <span className="text-xs theme-text-secondary">{saved}</span>}
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>
    </div>
  )
}
