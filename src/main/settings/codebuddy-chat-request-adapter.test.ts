import { describe, expect, it } from 'vitest'

import { adaptCodeBuddyChatCompletionsRequest } from './codebuddy-chat-request-adapter'

const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }

describe('adaptCodeBuddyChatCompletionsRequest', () => {
  it.each([
    '/data/codebuddy/clipboard-images/clipboard-2026-08-27T12-02-12-366Z-c876a6d7.png',
    '/tmp/workbuddy-clipboard-images/clipboard-2026-08-27T12-02-12-366Z-c876a6d7.webp',
    'C:\\data\\codebuddy\\clipboard-images\\clipboard-2026-08-27T12-02-12-366Z-c876a6d7.jpg'
  ])('removes a generated image path colocated with inline pixels: %s', (path) => {
    const request = {
      model: 'untrusted',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image.' },
            { type: 'text', text: `<image_local_path>${path}</image_local_path>` },
            image
          ]
        }
      ]
    }

    expect(adaptCodeBuddyChatCompletionsRequest(request)).toEqual({
      model: 'untrusted',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Describe this image.' }, image]
        }
      ]
    })
    expect(request.messages[0].content).toHaveLength(3)
  })

  it('normalizes every historical user message without changing other message content', () => {
    const generated =
      '<image_local_path>/data/clipboard-images/clipboard-2026-08-27T12-02-12-366Z-c876a6d7.gif</image_local_path>'
    const request = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: generated }, image] },
        { role: 'assistant', content: 'Earlier answer.' },
        { role: 'user', content: [{ type: 'text', text: generated }, image] }
      ]
    }

    expect(adaptCodeBuddyChatCompletionsRequest(request)).toEqual({
      messages: [
        { role: 'user', content: [image] },
        { role: 'assistant', content: 'Earlier answer.' },
        { role: 'user', content: [image] }
      ]
    })
  })

  it('removes a generated image path when CodeBuddy serializes the user content as text', () => {
    const request = {
      messages: [
        {
          role: 'user',
          content:
            'Describe this image.\n<image_local_path>/data/clipboard-images/clipboard-2026-08-27T12-02-12-366Z-c876a6d7.png</image_local_path>'
        }
      ]
    }

    expect(adaptCodeBuddyChatCompletionsRequest(request)).toEqual({
      messages: [{ role: 'user', content: 'Describe this image.' }]
    })
  })

  it('removes a generated image path even when a later CodeBuddy request omits inline pixels', () => {
    const request = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image.' },
            {
              type: 'text',
              text: '<image_local_path>/data/clipboard-images/clipboard-2026-08-27T12-02-12-366Z-c876a6d7.png</image_local_path>'
            }
          ]
        }
      ]
    }

    expect(adaptCodeBuddyChatCompletionsRequest(request)).toEqual({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe this image.' }] }]
    })
  })

  it.each([
    {
      name: 'ordinary path',
      content: [
        { type: 'text', text: '<image_local_path>/project/figure.png</image_local_path>' },
        image
      ]
    },
    {
      name: 'assistant message',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '<image_local_path>/data/clipboard-images/clipboard-2026-08-27T12-02-12-366Z-c876a6d7.png</image_local_path>'
        },
        image
      ]
    }
  ])('preserves $name content', ({ role = 'user', content }) => {
    const request = { messages: [{ role, content }] }
    expect(adaptCodeBuddyChatCompletionsRequest(request)).toBe(request)
  })
})
