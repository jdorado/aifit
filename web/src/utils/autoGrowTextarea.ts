import { useLayoutEffect, useRef } from 'react'

// Grow a single-line textarea with its content until CSS max-height caps it,
// then let it scroll internally. `active` re-applies the size when the field
// is conditionally mounted (for example a chat sheet that reopens with text).
export const useAutoGrowTextarea = (value: string, active = true) => {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const textarea = ref.current
    if (!active || !textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight}px`
  }, [active, value])

  return ref
}
