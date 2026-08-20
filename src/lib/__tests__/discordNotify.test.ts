import { describe, expect, it } from 'vitest'
import { discordUserIdFromIdentities, isDiscordWebhookUrl, turnNotificationMessage } from '../discordNotify'

describe('isDiscordWebhookUrl', () => {
  it('accepts a real Discord webhook URL', () => {
    expect(isDiscordWebhookUrl('https://discord.com/api/webhooks/123456789/abcDEF-123_xyz')).toBe(true)
  })

  it('rejects non-Discord URLs', () => {
    expect(isDiscordWebhookUrl('https://example.com/webhook')).toBe(false)
  })
})

describe('discordUserIdFromIdentities', () => {
  it('returns the Discord identity id', () => {
    expect(
      discordUserIdFromIdentities([
        { provider: 'discord', id: '111222333' },
        { provider: 'email', id: 'some-uuid' },
      ]),
    ).toBe('111222333')
  })

  it('returns null when there is no Discord identity', () => {
    expect(discordUserIdFromIdentities([{ provider: 'email', id: 'some-uuid' }])).toBe(null)
  })

  it('returns null for null/undefined identities', () => {
    expect(discordUserIdFromIdentities(null)).toBe(null)
    expect(discordUserIdFromIdentities(undefined)).toBe(null)
  })
})

describe('turnNotificationMessage', () => {
  it('starts with Rise & Fall and includes the round number when given', () => {
    const message = turnNotificationMessage({
      displayName: 'Alice',
      discordUserId: null,
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
      discordUserId: null,
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
      discordUserId: null,
      roomName: 'The War Room',
      roomCode: 'AB12',
      phase: 'place a tile',
      round: null,
      gameUrl: null,
    })
    expect(message).toBe("**Rise & Fall** — **Alice**, it's your turn to **place a tile** in **The War Room**.\nRoom `AB12`")
  })

  it('@mentions the player by Discord ID instead of bolding their name when available', () => {
    const message = turnNotificationMessage({
      displayName: 'Alice',
      discordUserId: '111222333',
      roomName: 'The War Room',
      roomCode: 'AB12',
      phase: 'select a card',
      round: 3,
      gameUrl: null,
    })
    expect(message).toBe("**Rise & Fall** — <@111222333>, it's your turn to **select a card** in **The War Room** (Round 3).\nRoom `AB12`")
  })
})
