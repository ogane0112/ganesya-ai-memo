// Example gmemo plugin. Copy this folder into $GMEMO_DATA_DIR/plugins/ and restart.
// Plugins run inside the server process with full trust: only install code you have read.
/** @type {{ name: string, setup(api: any): void }} */
export default {
  name: 'inbox-tools',
  setup(api) {
    // Use the server's zod instance for MCP input schemas (plugins have no node_modules of their own).
    const { z } = api;

    // 1. Extra sensitive-data rule: internal ticket IDs like "SEC-1234" are treated as confidential.
    api.registerSensitiveRule({
      id: 'internal-ticket',
      category: 'dictionary',
      label: '社内チケット番号',
      pattern: /\bSEC-\d{3,6}\b/g,
    });

    // 2. An MCP tool agents can call: summarize what is waiting in the Inbox folder.
    api.registerMcpTool({
      name: 'inbox_overview',
      description: 'List notes in the Inbox folder that still need sorting, oldest first.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
      handler: ({ limit }) => {
        const notes = api.notes.list('Inbox').slice(-(limit ?? 20));
        return JSON.stringify(
          notes.map((n) => ({ path: n.path, title: n.title })),
          null,
          2,
        );
      },
    });

    // 3. A REST endpoint for the signed-in user: GET /api/plugins/inbox-tools/count
    api.registerRoute({
      method: 'GET',
      path: '/count',
      handler: () => Response.json({ inbox: api.notes.list('Inbox').length }),
    });

    // 4. React to changes.
    api.on('change', (e) => api.log('notes changed', e.paths));
  },
};
