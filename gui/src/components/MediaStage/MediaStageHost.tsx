/**
 * MediaStageHost — 媒体面板常驻宿主（2026-08-15）
 *
 * 修复"视频面板打不开": 此前 MediaStage 仅作场景卡(media kind)挂载,
 * __mediaStage 接口只在卡存在时注册——语音"打开视频面板"无卡可开必失败。
 * 现常驻挂载(App 根层): 订阅全部 media/media_stage surface, 聚合 items
 * 渲染 MediaStage, 全局接口恒在; 2026-08-16 按音乐卡方式优化——fitContent
 * 浮动小卡 + 可拖动(位置持久化) + 内容驱动宽度, 经
 * SideSheet + crabpaw:hotspot-panel-visibility(name:'media') 联动让位。
 */
import { useState, useEffect, useCallback } from 'react'
import { useSceneSurfaces } from '../../lib/scene-client'
import { apiPost } from '../../lib/api'
import { SideSheet } from '../SideSheet'
import { MediaStage, type MediaItem } from './index'
import { registerCommandHost } from '../../lib/ui-command-registry'

export function MediaStageHost() {
  const { surfaces } = useSceneSurfaces()
  const [visible, setVisible] = useState(false)
  // 2026-08-16: 可拖动位置(SideSheet draggable)——localStorage 持久化, 刷新后恢复(音乐卡同款)
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    try {
      const raw = localStorage.getItem('crabpaw.media.dragOffset')
      if (raw) setDragOffset(JSON.parse(raw))
    } catch (e) { console.warn('[MediaStageHost] 读取拖拽位置失败:', e instanceof Error ? e.message : e) }
  }, [])
  useEffect(() => {
    try {
      if (dragOffset) localStorage.setItem('crabpaw.media.dragOffset', JSON.stringify(dragOffset))
    } catch (e) { console.warn('[MediaStageHost] 保存拖拽位置失败:', e instanceof Error ? e.message : e) }
  }, [dragOffset])

  // 聚合 media/media_stage surfaces 的 items
  const items: MediaItem[] = []
  const mediaSurfaceIds: string[] = []
  for (const s of surfaces) {
    if (s.kind !== 'media' && s.kind !== 'media_stage') continue
    mediaSurfaceIds.push(s.id)
    const list = s.data?.items
    if (Array.isArray(list)) {
      for (const it of list) {
        if (it && typeof it === 'object') items.push(it as MediaItem)
      }
    }
  }

  // 有媒体卡推送 → 自动打开(对齐原 MediaStage auto-show 语义)
  useEffect(() => {
    if (items.length > 0) setVisible(true)
  }, [items.length])

  // 组合布局联动(与热点/台风/股票同款事件, VoiceShell 按 name 聚合)
  // 2026-08-16 修复: 广播值 = visible && items.length > 0, 依赖补 items.length——
  // 此前仅广播 visible, LLM/工具路径关闭(如"关闭视频"落 LLM 删 surface →
  // items 归零 → 宿主渲染 null)不经过 setVisible(false), 最后一次广播是
  // visible:true → VoiceShell bigPanelStateRef['media'] 恒真 → 自动组合布局
  // 卡死不回归主界面。items 归零时同样补发 false。
  useEffect(() => {
    try {
      const v = visible && items.length > 0
      window.dispatchEvent(new CustomEvent('crabpaw:hotspot-panel-visibility', { detail: { visible: v, name: 'media' } }))
    } catch (e) { console.warn('[media-stage] 广播可见性事件失败(极端环境):', e) }
  }, [visible, items.length])

  const handleClose = useCallback(() => {
    setVisible(false)
    for (const id of mediaSurfaceIds) {
      apiPost('/api/scene/remove', { id }).catch(e => console.warn('[MediaStageHost] 移除 surface 失败:', e))
    }
  }, [mediaSurfaceIds.join(',')])

  // 全局接口(语音路由依赖)——恒注册, 无卡时 open 为 no-op
  // 2026-08-16 审计: close 从"仅隐藏"改为 handleClose(删 surfaces)——此前语音"关闭媒体"
  // 只 setVisible(false), surface 残留; 之后任意新媒体推送(items.length 变化)会触发
  // auto-open effect 把旧卡(用户已关闭的)重新弹出来。与 ×/Esc(handleClose)语义对齐:
  // 关闭即移除, 不再残留。
  useEffect(() => {
    // A1: 经 ui-command-registry 注册(旧 window.__mediaStage 退役)
    const unregisterMedia = registerCommandHost('mediaStage', {
      open: () => { if (items.length > 0) setVisible(true) },
      close: () => { handleClose() },
    })
    return () => { unregisterMedia() }
  }, [items.length, handleClose])

  if (items.length === 0) return null

  return (
    <SideSheet
      open={visible}
      onClose={handleClose}
      name="media"
      // 2026-08-16: 用户反馈"视频窗口占屏比太小"——40vw/480px 音乐卡档对视频过小。
      // 提至 75vw(≥70% 要求, 组合布局 body.side-sheet-media 按 70vw 档设计),
      // 封顶 1920px: 2560×1440 屏上仍 ≥75%, 更大屏不再无限放大。
      // 高度仍内容驱动(16:9 随宽), fitContent 浮动卡不变。
      width="min(75vw, 1920px)"
      fitContent
      draggable
      dragOffset={dragOffset ?? undefined}
      onDragOffsetChange={setDragOffset}
    >
      <MediaStage items={items} onClose={handleClose} />
    </SideSheet>
  )
}

export default MediaStageHost
