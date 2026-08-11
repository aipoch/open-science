#!/usr/bin/env node

/**
 * You.com Search MCP Server for Open Science
 * 
 * Provides web search capabilities through the You.com API as an MCP tool.
 * Supports both authenticated (with API key) and keyless search modes.
 * 
 * Usage:
 *   npx @open-science/youcom-mcp
 * 
 * Environment variables:
 *   YDC_API_KEY - Optional You.com API key for enhanced search features
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from '@modelcontextprotocol/sdk/types.js';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface YoucomSearchResponse {
  results?: SearchResult[];
  error?: string;
}

/**
 * Performs web search using You.com API
 */
async function searchYoucom(query: string, apiKey?: string): Promise<YoucomSearchResponse> {
  const baseUrl = apiKey ? 'https://api.ydc-index.io/search' : 'https://api.ydc-index.io/keyless-search';
  
  const params = new URLSearchParams({
    query,
    count: '10'
  });
  
  const headers: Record<string, string> = {
    'User-Agent': 'OpenScience-YouComMCP/0.1.0',
    'Content-Type': 'application/json'
  };
  
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }
  
  try {
    const response = await fetch(`${baseUrl}?${params}`, {
      method: 'GET',
      headers
    });
    
    if (!response.ok) {
      return {
        error: `You.com API error: ${response.status} ${response.statusText}`
      };
    }
    
    const data = await response.json() as any;
    
    // Handle different response formats from You.com API
    const results: SearchResult[] = [];
    
    if (data.hits) {
      // Standard API response format
      for (const hit of data.hits) {
        results.push({
          title: hit.title || hit.name || 'Untitled',
          url: hit.url,
          snippet: hit.snippets?.[0] || hit.description || ''
        });
      }
    } else if (data.web?.results) {
      // Alternative response format
      for (const result of data.web.results) {
        results.push({
          title: result.title || 'Untitled',
          url: result.url,
          snippet: result.description || result.snippet || ''
        });
      }
    }
    
    return { results };
    
  } catch (error) {
    return {
      error: `Search request failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

/**
 * Formats search results for display in Open Science
 */
function formatSearchResults(results: SearchResult[], query: string): string {
  if (results.length === 0) {
    return `No results found for "${query}"`;
  }
  
  let formatted = `Web search results for query: "${query}"\n\n`;
  
  for (const [index, result] of results.entries()) {
    formatted += `${index + 1}. **${result.title}**\n`;
    formatted += `   ${result.url}\n`;
    if (result.snippet) {
      formatted += `   ${result.snippet}\n`;
    }
    formatted += '\n';
  }
  
  return formatted;
}

/**
 * Main MCP server implementation
 */
const server = new Server(
  {
    name: 'youcom-search',
    version: '0.1.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// Register the web search tool
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'web_search',
        description: 'Search the web using You.com. Provides comprehensive web search results for research queries.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query to execute'
            },
            count: {
              type: 'number',
              description: 'Maximum number of results to return (default: 10)',
              minimum: 1,
              maximum: 20,
              default: 10
            }
          },
          required: ['query']
        }
      }
    ] satisfies Tool[]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'web_search') {
    const args = request.params.arguments as { query: string; count?: number };
    
    if (!args.query) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: query parameter is required'
          }
        ],
        isError: true
      } satisfies CallToolResult;
    }
    
    const apiKey = process.env.YDC_API_KEY;
    const searchResponse = await searchYoucom(args.query, apiKey);
    
    if (searchResponse.error) {
      return {
        content: [
          {
            type: 'text',
            text: `Search error: ${searchResponse.error}`
          }
        ],
        isError: true
      } satisfies CallToolResult;
    }
    
    const results = searchResponse.results || [];
    const limitedResults = results.slice(0, args.count || 10);
    const formattedResults = formatSearchResults(limitedResults, args.query);
    
    return {
      content: [
        {
          type: 'text',
          text: formattedResults
        }
      ]
    } satisfies CallToolResult;
  }
  
  return {
    content: [
      {
        type: 'text',
        text: `Unknown tool: ${request.params.name}`
      }
    ],
    isError: true
  } satisfies CallToolResult;
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // Keep the server running
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Failed to start You.com MCP server:', error);
  process.exit(1);
});