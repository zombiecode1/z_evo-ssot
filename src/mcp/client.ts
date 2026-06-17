/**
 * MCP Client — Connects to ZombieCoder MCP Server
 * 
 * This client spawns the MCP server as a separate process
 * and connects via stdio transport.
 * 
 * Reference: https://modelcontextprotocol.io/docs/sdk
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';

let mcpClient: Client | null = null;
let mcpTransport: StdioClientTransport | null = null;
let discoveredTools: any[] = [];

/**
 * Connect to the MCP server by spawning it as a child process.
 */
export async function connectMcpServer(): Promise<void> {
  try {
    // Path to the compiled MCP server entry point
    const serverEntryPath = path.join(__dirname, 'server-entry.js');
    
    console.log(`🔧 Starting MCP server: ${serverEntryPath}`);

    // Create transport that spawns the server as a child process
    mcpTransport = new StdioClientTransport({
      command: process.execPath, // node executable
      args: [serverEntryPath],
    });

    mcpClient = new Client({
      name: 'zombiedev-client',
      version: '1.0.0',
    });

    // Connect to the server
    await mcpClient.connect(mcpTransport);
    console.log('✅ MCP Client connected to server');

    // Discover available tools
    const toolsResult = await mcpClient.listTools();
    discoveredTools = toolsResult.tools;
    console.log(`🔧 MCP Tools discovered: ${discoveredTools.length}`);
    for (const tool of discoveredTools) {
      console.log(`   - ${tool.name}`);
    }
  } catch (err: any) {
    console.error('❌ MCP Client connection failed:', err.message);
    mcpClient = null;
    mcpTransport = null;
    discoveredTools = [];
  }
}

/**
 * Get list of discovered tools.
 */
export function getMcpTools(): any[] {
  return discoveredTools;
}

/**
 * Call a tool on the MCP server.
 */
export async function callMcpTool(name: string, args: Record<string, any>): Promise<any> {
  if (!mcpClient) {
    return { success: false, error: 'MCP client not connected' };
  }

  try {
    const result = await mcpClient.callTool({ name, arguments: args });
    
    // Parse the text content from result
    if (result.content && Array.isArray(result.content)) {
      const textContent = result.content.find((c: any) => c.type === 'text');
      if (textContent) {
        try {
          return JSON.parse(textContent.text);
        } catch {
          return { success: true, text: textContent.text };
        }
      }
    }
    
    return { success: true, raw: result };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Disconnect from MCP server.
 */
export async function disconnectMcpServer(): Promise<void> {
  if (mcpClient) {
    await mcpClient.close();
    mcpClient = null;
    mcpTransport = null;
    discoveredTools = [];
    console.log('🔌 MCP Client disconnected');
  }
}

/**
 * Check if MCP client is connected.
 */
export function isMcpConnected(): boolean {
  return mcpClient !== null;
}
