import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { McpServerConfig } from '../domain/types.js';

export class McpClientWrapper {
  private client: Client;
  private transport?: StdioClientTransport | SSEClientTransport;

  constructor(private config: McpServerConfig) {
    this.client = new Client({ name: 'acs-core', version: '0.1.0' }, { capabilities: {} });
  }

  public async connect(): Promise<void> {
    if (this.config.transport === 'stdio') {
      if (!this.config.command) throw new Error('Stdio transport requires a command');
      const mergedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) mergedEnv[k] = v;
      }
      if (this.config.env) {
        Object.assign(mergedEnv, this.config.env);
      }
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ? Object.values(this.config.args) : [],
        env: mergedEnv
      });
    } else if (this.config.transport === 'http') {
      if (!this.config.url) throw new Error('HTTP transport requires a URL');
      this.transport = new SSEClientTransport(new URL(this.config.url));
    } else {
      throw new Error(`Unsupported transport: ${this.config.transport}`);
    }

    await this.client.connect(this.transport);
  }

  public async listTools() {
    return await this.client.listTools();
  }

  public async callTool(name: string, args: Record<string, unknown>) {
    return await this.client.callTool({ name, arguments: args });
  }

  public async close() {
    if (this.transport) {
      await this.transport.close();
    }
  }
}
