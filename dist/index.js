import OpenAI from "openai";
import * as dotenv from "dotenv";
import z from "zod";
import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// Load environment variables
dotenv.config();
// Configure logging
const logger = {
    info: (message) => console.log(`[INFO] ${new Date().toISOString()} - ${message}`),
    error: (message) => console.error(`[ERROR] ${new Date().toISOString()} - ${message}`),
};
// OpenAI configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
let VECTOR_STORE_ID;
// Initialize OpenAI client
const openaiClient = OPENAI_API_KEY
    ? new OpenAI({
        apiKey: OPENAI_API_KEY,
    })
    : null;
async function getOrCreateVectorStore(id) {
    if (id)
        return id;
    const response = await openaiClient.vectorStores.create({ name: id });
    VECTOR_STORE_ID = response.id;
    logger.info("Created vector store: " + VECTOR_STORE_ID);
    return VECTOR_STORE_ID;
}
/**
 * Handle search tool execution
 */
async function handleSearch(args) {
    const { query } = args;
    if (!query || !query.trim()) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ results: [] }),
                },
            ],
        };
    }
    if (!openaiClient) {
        logger.error("OpenAI client not initialized - API key missing");
        throw new Error("OpenAI API key is required for vector store search");
    }
    try {
        logger.info(`Searching ${VECTOR_STORE_ID} for query: '${query}'`);
        // Search implementation
        const response = await openaiClient.vectorStores.files.list(VECTOR_STORE_ID, { limit: 20 });
        const results = [];
        if (response.data && response.data.length > 0) {
            for (let i = 0; i < response.data.length; i++) {
                const item = response.data[i];
                const result = {
                    id: item.id || `vs_${i}`,
                    title: `Document ${i + 1}`,
                    text: "Document snippet...",
                    url: `https://platform.openai.com/storage/files/${item.id}`,
                };
                results.push(result);
            }
        }
        logger.info(`Vector store search returned ${results.length} results`);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ results }),
                },
            ],
        };
    }
    catch (error) {
        logger.error(`Search error: ${error}`);
        throw error;
    }
}
/**
 * Handle fetch tool execution
 */
async function handleFetch(args) {
    const { id } = args;
    if (!id) {
        throw new Error("Document ID is required");
    }
    if (!openaiClient) {
        logger.error("OpenAI client not initialized - API key missing");
        throw new Error("OpenAI API key is required for vector store file retrieval");
    }
    try {
        logger.info(`Fetching content from vector store for file ID: ${id}`);
        const fileInfo = await openaiClient.vectorStores.files.retrieve(VECTOR_STORE_ID, id);
        const fileContent = await openaiClient.files.content(id);
        let content = "";
        if (typeof fileContent === "string") {
            content = fileContent;
        }
        else if (Buffer.isBuffer(fileContent)) {
            content = fileContent.toString("utf-8");
        }
        else {
            content = "No content available";
        }
        const result = {
            id: id,
            title: `Document ${id}`,
            text: content,
            url: `https://platform.openai.com/storage/files/${id}`,
            metadata: null,
        };
        logger.info(`Fetched vector store file: ${id}`);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result),
                },
            ],
        };
    }
    catch (error) {
        logger.error(`Fetch error: ${error}`);
        throw error;
    }
}
/**
 * Create and configure the MCP server
 */
async function createServer() {
    const server = new McpServer({
        name: "example-server",
        version: "1.0.0",
    });
    // Define tool schemas using zod
    const searchSchema = z.object({
        query: z
            .string()
            .min(2)
            .describe("Search query string. Natural language queries work best for semantic search."),
    });
    const fetchSchema = z.object({
        id: z
            .string()
            .describe("File ID from vector store (file-xxx) or local document ID"),
    });
    // Register tool metadata for listing
    server.registerTool("search", {
        title: "Search",
        description: `Search for documents using OpenAI Vector Store search.\nThis tool searches through the vector store to find semantically relevant matches. Returns a list of search results with basic information. Use the fetch tool to get complete document content.`,
        inputSchema: searchSchema.shape,
        outputSchema: z.object({
            results: z.array(z.object({
                id: z.string(),
                title: z.string(),
                text: z.string(),
                url: z.string(),
            })),
        }).shape,
    }, handleSearch);
    server.registerTool("fetch", {
        title: "Fetch",
        description: "Fetch complete document content by ID.",
        inputSchema: fetchSchema.shape,
        outputSchema: z.object({
            id: z.string(),
            title: z.string(),
            text: z.string(),
            url: z.string(),
            metadata: z.any().nullable(),
        }).shape,
    }, handleFetch);
    // Register tool execution handler with safeParse for validation
    // server.setRequestHandler(CallToolRequestSchema, async (request) => {
    //   const { name, arguments: args } = request.params;
    //   if (name === "search") {
    //     const parsed = searchSchema.safeParse(args);
    //     if (!parsed.success) {
    //       return {
    //         isError: true,
    //         content: [
    //           {
    //             type: "text",
    //             text: `Invalid arguments for search: ${parsed.error.message}`,
    //           },
    //         ],
    //       };
    //     }
    //     // Type assertion is safe here because zod schema ensures required fields
    //     return await handleSearch(parsed.data as { query: string });
    //   } else if (name === "fetch") {
    //     const parsed = fetchSchema.safeParse(args);
    //     if (!parsed.success) {
    //       return {
    //         isError: true,
    //         content: [
    //           {
    //             type: "text",
    //             text: `Invalid arguments for fetch: ${parsed.error.message}`,
    //           },
    //         ],
    //       };
    //     }
    //     // Type assertion is safe here because zod schema ensures required fields
    //     return await handleFetch(parsed.data as { id: string });
    //   } else {
    //     return {
    //       isError: true,
    //       content: [
    //         {
    //           type: "text",
    //           text: `Unknown tool: ${name}`,
    //         },
    //       ],
    //     };
    //   }
    // });
    return server;
}
/**
 * Main function to start the MCP server with stdio transport
 */
// async function main() {
//   try {
//     // Verify OpenAI client is initialized
//     if (!openaiClient) {
//       logger.error(
//         "OpenAI API key not found. Please set OPENAI_API_KEY environment variable."
//       );
//       throw new Error("OpenAI API key is required");
//     }
//     VECTOR_STORE_ID = await getOrCreateVectorStore(process.env.VECTOR_STORE_ID);
//     logger.info(`Using vector store: ${VECTOR_STORE_ID}`);
//     // Create MCP server
//     const server = await createServer();
//     const transport = new StdioServerTransport();
//     await server.connect(transport);
//     logger.info("MCP server running on stdio");
//     // Handle graceful shutdown
//     process.on("SIGINT", () => {
//       logger.info("Server stopped by user");
//       process.exit(0);
//     });
//   } catch (error) {
//     logger.error(`Server error: ${error}`);
//     process.exit(1);
//   }
// }
// await main();
const app = express();
app.use(express.json());
// Map to store transports by session ID
const transports = {};
// Handle POST requests for client-to-server communication
app.post("/mcp", async (req, res) => {
    try {
        // Check for existing session ID
        const sessionId = req.headers["mcp-session-id"];
        let transport;
        if (sessionId && transports[sessionId]) {
            // Reuse existing transport
            transport = transports[sessionId];
        }
        else if (!sessionId && isInitializeRequest(req.body)) {
            // New initialization request
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sessionId) => {
                    // Store the transport by session ID
                    transports[sessionId] = transport;
                },
                // DNS rebinding protection is disabled by default for backwards compatibility. If you are running this server
                // locally, make sure to set:
                // enableDnsRebindingProtection: true,
                // allowedHosts: ['127.0.0.1'],
            });
            // Clean up transport when closed
            transport.onclose = () => {
                if (transport.sessionId) {
                    delete transports[transport.sessionId];
                }
            };
            const server = await createServer();
            // Connect to the MCP server
            await server.connect(transport);
        }
        else {
            // Invalid request
            res.status(400).json({
                jsonrpc: "2.0",
                error: {
                    code: -32000,
                    message: "Bad Request: No valid session ID provided",
                },
                id: null,
            });
            return;
        }
        // Handle the request
        await transport.handleRequest(req, res, req.body);
    }
    catch (error) {
        logger.error(`Server error: ${error}`);
        res.status(400).json({
            jsonrpc: "2.0",
        });
        return;
    }
});
// Reusable handler for GET and DELETE requests
const handleSessionRequest = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing session ID");
        return;
    }
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
};
// Handle GET requests for server-to-client notifications via SSE
app.get("/mcp", handleSessionRequest);
// Handle DELETE requests for session termination
app.delete("/mcp", handleSessionRequest);
app.listen(process.env.PORT || 3000, () => {
    logger.info(`Server listening on port ${process.env.PORT || 3000}`);
});
//# sourceMappingURL=index.js.map