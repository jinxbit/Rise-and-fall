import { describe, expect, it } from 'vitest'
import { isDiscordWebhookUrl, turnNotificationMessage } from '../discordNotify'

describe('turnNotificationMessage', () => {
  it('links to the game when a URL is given', () => {
    const message = turnNotificationMessage({
      roomCode: 'AB12',
      roomName: 'The War Room',
      displayName: 'Alice',
      phase: 'select a card',
      gameUrl: 'https://example.com/game/AB12',
    })
    expect(message).toBe("**Alice**, it's your turn to **select a card** in **The War Room**.\nhttps://example.com/game/AB12")
  })

  it('falls back to the room code when no URL is given', () => {
    const message = turnNotificationMessage({
      roomCode: 'AB12',
      roomName: 'The War Room',
      displayName: 'Alice',
      phase: 'select a card',
    })
    expect(message).toBe("**Alice**, it's your turn to **select a card** in **The War Room**. (`AB12`)")
  })
})

describe('isDiscordWebhookUrl', () => {
  it('accepts a well-formed Discord webhook URL', () => {
    expect(isDiscordWebhookUrl('https://discord.com/api/webhooks/123456789/abcDEF-123_xyz')).toBe(true)
  })

  it('rejects non-Discord URLs', () => {
    expect(isDiscordWebhookUrl('https://example.com/webhooks/123/abc')).toBe(false)
  })
})
