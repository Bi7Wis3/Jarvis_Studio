import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { callTool, type AnyTool } from './tools.js';

/** Exposes the studio tools to external MCP clients over stateless Streamable HTTP at /mcp. */
export function registerMcpHttp(app: FastifyInstance, tools: AnyTool[]): void {
    app.post('/mcp', async (request, reply) => {
        const server = new McpServer({ name: 'jarvis-studio', version: '0.1.0' });
        for (const t of tools) {
            server.registerTool(t.name, { description: t.description, inputSchema: t.schema }, (args: unknown) =>
                callTool(t, args));
        }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        reply.raw.on('close', () => {
            void transport.close();
            void server.close();
        });
        reply.hijack();
        await server.connect(transport);
        await transport.handleRequest(request.raw, reply.raw, request.body);
    });

    const notAllowed = async (_request: unknown, reply: any) => {
        reply.code(405).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
    };
    app.get('/mcp', notAllowed);
    app.delete('/mcp', notAllowed);
}
