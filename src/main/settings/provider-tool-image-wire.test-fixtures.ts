// Captured on 2026-08-14 from real framework runs against loopback MCP/model servers. These
// fixtures start at each framework's final provider request boundary, after the MCP result was
// converted by Claude Code 2.1.219, OpenCode 1.18.3, or Codex CLI 0.144.6.
export const CAPTURED_TOOL_IMAGE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgAQMAAABJtOi3AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6ggOATA4XSJK7AAAAAxJREFUCNdjYBjcAAAAoAABYSV9RwAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wOC0xNFQwMTo0ODo1NiswMDowMHHzd54AAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDgtMTRUMDE6NDg6NTYrMDA6MDAArs8iAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA4LTE0VDAxOjQ4OjU2KzAwOjAwV7vu/QAAAABJRU5ErkJggg=='

export const CLAUDE_CODE_TOOL_IMAGE_REQUEST_FIXTURE = {
  messages: [
    {
      role: 'user',
      content: [
        {
          tool_use_id: 'toolu_fixture_1',
          type: 'tool_result',
          content: [
            { type: 'text', text: '{"status":"completed"}' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: CAPTURED_TOOL_IMAGE_PNG_BASE64
              }
            }
          ],
          cache_control: { type: 'ephemeral' }
        }
      ]
    }
  ]
} as const

export const OPENCODE_TOOL_IMAGE_REQUEST_FIXTURE = {
  messages: [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_fixture_1',
          type: 'function',
          function: { name: 'fixture_show_image', arguments: '{}' }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'call_fixture_1',
      content: '{"status":"completed"}'
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Attached media from tool result:' },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${CAPTURED_TOOL_IMAGE_PNG_BASE64}`
          }
        }
      ]
    }
  ]
} as const

export const OPENCODE_ANTHROPIC_TOOL_IMAGE_REQUEST_FIXTURE = {
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Call the show_image tool exactly once, then answer done.'
        }
      ]
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_fixture_1',
          name: 'fixture_show_image',
          input: {},
          cache_control: { type: 'ephemeral' }
        }
      ]
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_fixture_1',
          content: [
            { type: 'text', text: '{"status":"completed"}' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: CAPTURED_TOOL_IMAGE_PNG_BASE64
              }
            }
          ],
          cache_control: { type: 'ephemeral' }
        }
      ]
    }
  ]
} as const

export const CODEX_NATIVE_TOOL_IMAGE_REQUEST_FIXTURE = {
  input: [
    {
      type: 'function_call',
      name: 'show_image',
      namespace: 'mcp__fixture',
      arguments: '{}',
      call_id: 'call_fixture_1'
    },
    {
      type: 'function_call_output',
      call_id: 'call_fixture_1',
      output: [
        { type: 'input_text', text: 'Wall time: 0.0058 seconds\nOutput:' },
        { type: 'input_text', text: '{"status":"completed"}' },
        {
          type: 'input_image',
          image_url: `data:image/png;base64,${CAPTURED_TOOL_IMAGE_PNG_BASE64}`,
          detail: 'high'
        }
      ]
    }
  ]
} as const
