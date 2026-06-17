/**
 * MCP Server Entry Point
 * 
 * This is a standalone process that runs the MCP server.
 * The agent chat connects to this via stdio transport.
 * 
 * Usage: node dist/mcp/server-entry.js
 */

import { startMcpServer } from './server';

startMcpServer().catch(err => {
  console.error('MCP Server failed:', err);
  process.exit(1);
});
