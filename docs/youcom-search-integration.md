# You.com Search Integration for Open Science

This guide shows how to add You.com web search capabilities to your Open Science research workspace using the included MCP server.

## Overview

The You.com MCP server provides high-quality web search results that integrate seamlessly with Open Science's research workflows. It supports both authenticated (with API key) and keyless search modes, making it accessible for all users while providing enhanced features for those with API keys.

## Installation

The You.com MCP server is included with Open Science. To set it up:

### 1. Build the MCP Server

```bash
cd mcp-servers/youcom
npm install
npm run build
```

### 2. Add to MCP Configuration

Add the following configuration to your Open Science settings or MCP configuration file:

#### With API Key (Recommended)

```json
{
  "name": "youcom-search",
  "displayName": "You.com Search",
  "description": "High-quality web search for research workflows",
  "transport": "stdio",
  "command": "node",
  "args": ["mcp-servers/youcom/dist/index.js"],
  "env": {
    "YDC_API_KEY": "your-api-key-here"
  },
  "enabled": true
}
```

#### Without API Key (Basic Mode)

```json
{
  "name": "youcom-search",
  "displayName": "You.com Search",
  "description": "Web search for research workflows",
  "transport": "stdio", 
  "command": "node",
  "args": ["mcp-servers/youcom/dist/index.js"],
  "enabled": true
}
```

### 3. Obtain API Key (Optional)

For enhanced search capabilities:

1. Visit [You.com API](https://api.you.com)
2. Sign up for an API key
3. Add the key to your MCP configuration as `YDC_API_KEY`

## Usage in Research Workflows

Once configured, you can use You.com search in your Open Science sessions:

### Literature Review

```
Search for recent CRISPR developments in 2024
```

The agent will use the You.com search tool to find relevant research papers and developments.

### Data Discovery

```
Find open datasets related to climate change modeling
```

Helps locate publicly available datasets for your research.

### Background Research

```
What are the latest developments in quantum computing algorithms?
```

Provides comprehensive web search results for research context.

### Reference Validation

```
Search for recent publications on machine learning interpretability
```

Validates and expands on research citations and references.

## Search Results Format

Results are formatted for research workflows:

```
Web search results for query: "CRISPR gene editing recent advances 2024"

1. **CRISPR-Cas9 Breakthrough in Gene Therapy**
   https://example.com/research-article
   Recent study shows improved precision in gene editing...

2. **Clinical Trial Results for CRISPR Treatment**
   https://clinical-trials.gov/study
   Phase II trial demonstrates safety and efficacy...
```

## Features

- **High-Quality Results**: You.com's search algorithm optimized for factual, authoritative content
- **Research-Focused**: Results prioritize academic sources, papers, and authoritative websites  
- **Comprehensive Coverage**: Access to recent content and diverse information sources
- **Error Handling**: Graceful fallbacks when search APIs are unavailable
- **Privacy-Friendly**: Local processing with optional API key authentication

## Troubleshooting

### MCP Server Won't Start

1. Ensure Node.js is installed and accessible
2. Check that the build completed successfully (`npm run build`)
3. Verify the path to the MCP server in your configuration

### No Search Results

1. Check your internet connection
2. Verify the API key if using authenticated mode
3. Try a different search query
4. Check Open Science logs for error messages

### API Rate Limits

If you encounter rate limits:

1. Consider upgrading your You.com API plan
2. Space out search requests in your workflows
3. Use keyless mode for basic functionality

## Integration Benefits

Adding You.com search to Open Science enhances research workflows by:

- **Expanding Knowledge Base**: Access to current web information beyond training data
- **Research Validation**: Cross-reference findings with recent publications
- **Trend Analysis**: Track emerging developments in research areas  
- **Source Discovery**: Find authoritative sources and datasets
- **Context Building**: Gather background information for research projects

This integration maintains Open Science's commitment to open, reproducible research while providing powerful web search capabilities.