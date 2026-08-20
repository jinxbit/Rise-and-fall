import { describe, expect, it } from 'vitest'
import { isDiscordWebhookUrl, turnNotificationMessage } from '../discordNotify'

describe('isDiscordWebhookUrl', () => {
  it('accepts a real Discord webhook URL', () => {
    expect(isDiscordWebhookUrl('https://discord.com/api/webhooks/123456789/abcDEF-123_xyz')).toBe(true)
  })

  it('rejects non-Discord URLs', () => {
    expect(isDiscordWebhookUrl('https://example.com/webhook')).toBe(false)
  })
})

describe('turnNotificationMessage', () => {
  it('starts with Rise & Fall and includes the round number when given', () => {
    const message = turnNotificationMessage({
      displayName: 'Alice',
      roomName: 'The War Room',
      roomCode: 'AB12',
      phase: 'select a card',
      round: 3,
      gameUrl: 'https://example.com/game/AB12',
    })
    expect(message).toBe(
      "**Rise & Fall** — **Alice**, it's your turn to **select a card** in **[The War Room](https://example.com/game/AB12)** (Round 3).",
    )
  })

  it('falls back to the room code when no game link is available', () => {
    const message = turnNotificationMessage({
      displayName: 'Alice',
      roomName: 'The War Room',
      roomCode: 'AB12',
      phase: 'select a card',
      round: 3,
      gameUrl: null,
    })
    expect(message).toBe("**Rise & Fall** — **Alice**, it's your turn to **select a card** in **The War Room** (Round 3).\nRoom `AB12`")
  })

  it('omits the round number during board setup', () => {
    const message = turnNotificationMessage({
      displayName: 'Alice',
      roomName: 'The War Room',
      roomCode: 'AB12',
      phase: 'place a tile',
      round: null,
      gameUrl: null,
    })
    expect(message).toBe("**Rise & Fall** — **Alice**, it's your turn to **place a tile** in **The War Room**.\nRoom `AB12`")
  })
})
