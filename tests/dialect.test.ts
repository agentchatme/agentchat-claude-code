import { describe, expect, it } from 'vitest'
import { sessionStartOutput, userPromptOutput } from '../src/dialect.js'

describe('Claude Code hook output', () => {
  it('surfaces a pending review to the user and the model separately', () => {
    expect(sessionStartOutput('trusted model context', 'visible notice')).toEqual({
      systemMessage: 'visible notice',
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'trusted model context',
      },
    })
    expect(userPromptOutput('context', null)).not.toHaveProperty('systemMessage')
  })
})
