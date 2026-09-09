import { ARCHETYPE_PERSONA, DEFAULT_PERSONA, personaPrefix, resolvePersona, resolveVoiceStyle } from './expert-persona'

describe('expert-persona (P4)', () => {
  it('覆盖 subagent-tools 全 archetype 枚举', () => {
    const archetypes = ['planner', 'researcher', 'code_executor', 'critic', 'summarizer', 'tools_agent', 'archivist', 'orchestrator']
    for (const a of archetypes) {
      expect(ARCHETYPE_PERSONA[a]).toBeDefined()
      expect(ARCHETYPE_PERSONA[a].style.trim().length).toBeGreaterThan(0)
    }
  })
  it('未知 archetype 兜底 DEFAULT_PERSONA', () => {
    expect(resolvePersona('ghost')).toBe(DEFAULT_PERSONA)
    expect(resolveVoiceStyle('ghost')).toBe(DEFAULT_PERSONA.style)
  })
  it('personaPrefix 返回 "XX专家汇报："', () => {
    expect(personaPrefix('critic')).toBe('评审专家汇报：')
    expect(personaPrefix('unknown')).toBe('专家汇报：')
  })
})
