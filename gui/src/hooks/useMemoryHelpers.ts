import { useState, useRef, useEffect, useCallback } from 'react'

export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setDebouncedValue(value), delay)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [value, delay])
  return debouncedValue
}

export function useSearchAbort() {
  const controllerRef = useRef<AbortController | null>(null)
  const abort = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort()
      controllerRef.current = null
    }
  }, [])
  const getController = useCallback(() => {
    abort()
    const c = new AbortController()
    controllerRef.current = c
    return c
  }, [abort])
  // 2026-08-07: 组件卸载时中止在途搜索——防止卸载后 fetch 继续占用连接/触发已卸载回调
  useEffect(() => {
    return () => {
      if (controllerRef.current) {
        try {
          controllerRef.current.abort()
        } catch (e) {
          console.warn('[useMemoryHelpers] 卸载中止搜索失败:', e)
        }
        controllerRef.current = null
      }
    }
  }, [])
  return { getController, abort }
}
