"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.openaiClient = exports.VECTOR_STORE_ID = exports.logger = void 0;
const openai_1 = __importDefault(require("openai"));
const dotenv = __importStar(require("dotenv"));
const zod_1 = __importDefault(require("zod"));
const express_1 = __importDefault(require("express"));
const node_crypto_1 = require("node:crypto");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const webhookHandler_1 = __importDefault(require("./webhookHandler"));
// Load environment variables
dotenv.config();
// Configure logging
exports.logger = {
    info: (message) => console.log(`[INFO] ${new Date().toISOString()} - ${message}`),
    error: (message) => console.error(`[ERROR] ${new Date().toISOString()} - ${message}`),
};
// OpenAI configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
exports.VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;
// Initialize OpenAI client
exports.openaiClient = OPENAI_API_KEY
    ? new openai_1.default({
        apiKey: OPENAI_API_KEY,
    })
    : null;
async function getOrCreateVectorStore(id) {
    if (id)
        return id;
    const response = await exports.openaiClient.vectorStores.create({ name: id });
    exports.VECTOR_STORE_ID = response.id;
    exports.logger.info("Created vector store: " + exports.VECTOR_STORE_ID);
    return exports.VECTOR_STORE_ID;
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
    if (!exports.openaiClient) {
        exports.logger.error("OpenAI client not initialized - API key missing");
        throw new Error("OpenAI API key is required for vector store search");
    }
    try {
        exports.logger.info(`Searching ${exports.VECTOR_STORE_ID} for query: '${query}'`);
        // Search implementation
        const response = await exports.openaiClient.vectorStores.files.list(exports.VECTOR_STORE_ID, { limit: 20 });
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
        exports.logger.info(`Vector store search returned ${results.length} results`);
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
        exports.logger.error(`Search error: ${error}`);
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
    if (!exports.openaiClient) {
        exports.logger.error("OpenAI client not initialized - API key missing");
        throw new Error("OpenAI API key is required for vector store file retrieval");
    }
    try {
        exports.logger.info(`Fetching content from vector store for file ID: ${id}`);
        const fileInfo = await exports.openaiClient.vectorStores.files.retrieve(exports.VECTOR_STORE_ID, id);
        const fileContent = await exports.openaiClient.files.content(id);
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
        exports.logger.info(`Fetched vector store file: ${id}`);
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
        exports.logger.error(`Fetch error: ${error}`);
        throw error;
    }
}
/**
 * Create and configure the MCP server
 */
async function createServer() {
    const server = new mcp_js_1.McpServer({
        name: "example-server",
        version: "1.0.0",
    });
    // Define tool schemas using zod
    const searchSchema = zod_1.default.object({
        query: zod_1.default
            .string()
            .min(2)
            .describe("Search query string. Natural language queries work best for semantic search."),
    });
    const fetchSchema = zod_1.default.object({
        id: zod_1.default
            .string()
            .describe("File ID from vector store (file-xxx) or local document ID"),
    });
    // Register tool metadata for listing
    server.registerTool("search", {
        title: "Search",
        description: `Search for documents using OpenAI Vector Store search.\nThis tool searches through the vector store to find semantically relevant matches. Returns a list of search results with basic information. Use the fetch tool to get complete document content.`,
        inputSchema: searchSchema.shape,
        outputSchema: zod_1.default.object({
            results: zod_1.default.array(zod_1.default.object({
                id: zod_1.default.string(),
                title: zod_1.default.string(),
                text: zod_1.default.string(),
                url: zod_1.default.string(),
            })),
        }).shape,
    }, handleSearch);
    server.registerTool("fetch", {
        title: "Fetch",
        description: "Fetch complete document content by ID.",
        inputSchema: fetchSchema.shape,
        outputSchema: zod_1.default.object({
            id: zod_1.default.string(),
            title: zod_1.default.string(),
            text: zod_1.default.string(),
            url: zod_1.default.string(),
            metadata: zod_1.default.any().nullable(),
        }).shape,
    }, handleFetch);
    return server;
}
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: "10mb" }));
app.use(express_1.default.raw({ type: "application/json" }));
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
        else if (!sessionId && (0, types_js_1.isInitializeRequest)(req.body)) {
            // New initialization request
            transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
                sessionIdGenerator: () => (0, node_crypto_1.randomUUID)(),
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
        exports.logger.error(`Server error: ${error}`);
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
// Webhook endpoint for repo updates
app.post('/webhook', (req, res) => webhookHandler_1.default.handleWebhook(req, res));
app.get('/jobs/:jobId', (req, res) => webhookHandler_1.default.getJobStatus(req, res));
app.get('/queue/stats', (req, res) => webhookHandler_1.default.getQueueStats(req, res));
app.listen(process.env.PORT || 3000, () => {
    exports.logger.info(`Server listening on port ${process.env.PORT || 3000}`);
});
//# sourceMappingURL=index.js.map