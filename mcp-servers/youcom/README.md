# You.com Search MCP Server for Open Science

An MCP (Model Context Protocol) server that provides web search capabilities through the You.com API for Open Science research workflows.

## Features

- **Comprehensive Web Search**: Access You.com's high-quality search results for research queries
- **Dual Mode Support**: Works with both authenticated (API key) and keyless search modes
- **Research-Optimized**: Formatted results designed for scientific and academic research workflows
- **Easy Integration**: Standard MCP protocol for seamless Open Science integration
- **Error Handling**: Robust error handling with helpful fallback messages

## Installation

```bash
cd mcp-servers/youcom
npm install
npm run build
```

## Usage

### As an MCP Server (Recommended)

Add to your Open Science MCP configuration:

```json
{
  "name": "youcom-search",
  "command": "node",
  "args": ["/path/to/open-science/mcp-servers/youcom/dist/index.js"],
  "env": {
    "YDC_API_KEY": "your-api-key-here"
  }
}
```

The `YDC_API_KEY` environment variable is optional. If not provided, the server will use You.com's keyless search API with basic functionality.

### Available Tools

#### `web_search`

Searches the web using You.com's search API.

**Parameters:**
- `query` (string, required): The search query to execute
- `count` (number, optional): Maximum number of results to return (1-20, default: 10)

**Example:**
```typescript
await callTool('web_search', {
  query: 'CRISPR gene editing recent advances 2024',
  count: 8
});
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `YDC_API_KEY` | You.com API key for enhanced search features | No |

## API Key Setup

To get enhanced You.com search capabilities:

1. Visit [You.com API](https://api.you.com) to obtain an API key
2. Set the `YDC_API_KEY` environment variable in your MCP configuration
3. Without an API key, the server will use keyless search with basic functionality

## Output Format

Search results are formatted for research workflows:

```
Web search results for query: "your search query"

1. **Result Title**
   https://example.com/article
   Brief snippet describing the content...

2. **Another Result**
   https://example.com/paper
   Research summary or description...
```

## Error Handling

The server handles various error conditions gracefully:

- **API Errors**: Returns helpful error messages for API failures
- **Network Issues**: Provides fallback behavior for connectivity problems
- **Invalid Queries**: Validates input parameters and provides clear error messages
- **Rate Limiting**: Handles API rate limits with appropriate error messages

## Integration with Open Science

This MCP server integrates seamlessly with Open Science's research workflows:

1. **Literature Review**: Search for recent papers and research developments
2. **Data Source Discovery**: Find datasets, repositories, and research resources
3. **Background Research**: Gather contextual information for research projects
4. **Reference Validation**: Verify and expand on research citations
5. **Trend Analysis**: Track emerging trends in specific research areas

The server follows Open Science's MCP patterns and provides structured output that integrates well with the research workbench interface.

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Start in development mode
npm run dev
```

## License

Apache 2.0 - Same as Open Science

## Contributing

This MCP server follows Open Science's contribution guidelines. Please ensure:

1. TypeScript compilation passes without errors
2. Search functionality works with both authenticated and keyless modes
3. Error handling provides helpful user feedback
4. Output formatting is consistent with Open Science patterns