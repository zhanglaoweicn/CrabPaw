/**
 * 技能路由遮蔽回归（2026-08-21 审计 P0-1 skills）：
 * 泛 POST /^\/skills\/[^/]+$/ 若排在具体路由之前，create/edit/install-deps 全被 toggle 吞掉。
 */
const { describe, expect, it } = require('@jest/globals')
const { resolveRoute, LOCAL_HANDLERS } = require('../cli/request-handler')

describe('技能路由解析（route-order 遮蔽回归）', () => {
  it('POST /skills/create → handleSkillCreate（此前被 toggle 遮蔽）', () => {
    expect(resolveRoute('POST', '/skills/create')).toBe(LOCAL_HANDLERS.handleSkillCreate)
  })
  it('POST /skills/edit → handleSkillEdit', () => {
    expect(resolveRoute('POST', '/skills/edit')).toBe(LOCAL_HANDLERS.handleSkillEdit)
  })
  it('POST /skills/install-deps → handleSkillInstallDeps', () => {
    expect(resolveRoute('POST', '/skills/install-deps')).toBe(LOCAL_HANDLERS.handleSkillInstallDeps)
  })
  it('POST /skills/market/install → handleSkillMarketInstall', () => {
    expect(resolveRoute('POST', '/skills/market/install')).toBe(LOCAL_HANDLERS.handleSkillMarketInstall)
  })
  it('POST /skills/evolution/trigger → handleSkillEvolutionTrigger（多段路径不受影响）', () => {
    expect(resolveRoute('POST', '/skills/evolution/trigger')).toBe(LOCAL_HANDLERS.handleSkillEvolutionTrigger)
  })
  it('泛 id 路由仍指向 handleSkillToggle（POST 与 PATCH 一致）', () => {
    expect(resolveRoute('POST', '/skills/some-skill-id')).toBe(LOCAL_HANDLERS.handleSkillToggle)
    expect(resolveRoute('PATCH', '/skills/some-skill-id')).toBe(LOCAL_HANDLERS.handleSkillToggle)
  })
  it('GET /skills → handleSkills（泛路由不吞 GET）', () => {
    expect(resolveRoute('GET', '/skills')).toBe(LOCAL_HANDLERS.handleSkills)
  })
})
