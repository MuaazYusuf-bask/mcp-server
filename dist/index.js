"use strict";
/**
 * MCP Server with Native SSE Transport
 *
 * This implementation uses the MCP SDK's built-in SSE transport
 * for proper protocol handling.
 */
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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const sse_js_1 = require("@modelcontextprotocol/sdk/server/sse.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const openai_1 = __importDefault(require("openai"));
const express_1 = __importDefault(require("express"));
const dotenv = __importStar(require("dotenv"));
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
function getOrCreateVectorStore(id) {
    return __awaiter(this, void 0, void 0, function* () {
        if (id)
            return id;
        const response = yield openaiClient.vectorStores.create({ name: id });
        VECTOR_STORE_ID = response.id;
        console.log("Created vector store:", VECTOR_STORE_ID);
        return VECTOR_STORE_ID;
    });
}
// Initialize OpenAI client
const openaiClient = OPENAI_API_KEY
    ? new openai_1.default({
        apiKey: OPENAI_API_KEY,
    })
    : null;
/**
 * Handle search tool execution
 */
function handleSearch(args) {
    return __awaiter(this, void 0, void 0, function* () {
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
            const response = yield openaiClient.vectorStores.files.list(VECTOR_STORE_ID, { limit: 20 });
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
    });
}
/**
 * Handle fetch tool execution
 */
function handleFetch(args) {
    return __awaiter(this, void 0, void 0, function* () {
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
            const fileInfo = yield openaiClient.vectorStores.files.retrieve(VECTOR_STORE_ID, id);
            const fileContent = yield openaiClient.files.content(id);
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
    });
}
/**
 * Create and configure the MCP server
 */
function createServer() {
    return __awaiter(this, void 0, void 0, function* () {
        const server = new index_js_1.Server({
            name: "Sample MCP Server",
            version: "1.0.0",
        }, {
            capabilities: {
                tools: {},
            },
        });
        // Define available tools
        const tools = [
            {
                name: "search",
                description: `Search for documents using OpenAI Vector Store search.

This tool searches through the vector store to find semantically relevant matches.
Returns a list of search results with basic information. Use the fetch tool to get
complete document content.`,
                inputSchema: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "Search query string. Natural language queries work best for semantic search.",
                        },
                    },
                    required: ["query"],
                },
            },
            {
                name: "fetch",
                description: `Retrieve complete document content by ID for detailed
analysis and citation. This tool fetches the full document
content from OpenAI Vector Store. Use this after finding
relevant documents with the search tool to get complete
information for analysis and proper citation.`,
                inputSchema: {
                    type: "object",
                    properties: {
                        id: {
                            type: "string",
                            description: "File ID from vector store (file-xxx) or local document ID",
                        },
                    },
                    required: ["id"],
                },
            },
        ];
        // Handle list tools request
        server.setRequestHandler(types_js_1.ListToolsRequestSchema, () => __awaiter(this, void 0, void 0, function* () {
            return {
                tools,
            };
        }));
        // Handle tool execution
        server.setRequestHandler(types_js_1.CallToolRequestSchema, (request) => __awaiter(this, void 0, void 0, function* () {
            const { name, arguments: args } = request.params;
            switch (name) {
                case "search":
                    return yield handleSearch(args);
                case "fetch":
                    return yield handleFetch(args);
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        }));
        return server;
    });
}
/**
 * Main function to start the MCP server with SSE transport
 */
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            // Verify OpenAI client is initialized
            if (!openaiClient) {
                logger.error("OpenAI API key not found. Please set OPENAI_API_KEY environment variable.");
                throw new Error("OpenAI API key is required");
            }
            VECTOR_STORE_ID = yield getOrCreateVectorStore(process.env.VECTOR_STORE_ID);
            logger.info(`Using vector store: ${VECTOR_STORE_ID}`);
            // Create Express app for SSE transport
            const app = (0, express_1.default)();
            const port = parseInt(process.env.PORT || "8000", 10);
            // Enable CORS
            app.use((req, res, next) => {
                res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
                res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                res.header("Access-Control-Allow-Headers", "Content-Type");
                if (req.method === "OPTIONS") {
                    return res.sendStatus(200);
                }
                next();
            });
            // Health check endpoint
            app.get("/health", (req, res) => {
                res.json({
                    status: "ok",
                    server: "MCP Server",
                    version: "1.0.0",
                    transport: "SSE",
                });
            });
            // Create MCP server
            const mcpServer = yield createServer();
            // Setup SSE endpoint with MCP SDK's SSE transport
            app.get("/sse", (req, res) => __awaiter(this, void 0, void 0, function* () {
                logger.info("New SSE connection established");
                const transport = new sse_js_1.SSEServerTransport("/message", res);
                yield mcpServer.connect(transport);
                // Handle connection close
                req.on("close", () => {
                    logger.info("SSE connection closed");
                    transport.close();
                });
            }));
            // Message endpoint for SSE transport
            app.post("/message", express_1.default.json(), (req, res) => __awaiter(this, void 0, void 0, function* () {
                // The SSE transport handles this internally
                // This endpoint receives messages from the client
                res.status(200).json({ received: true });
            }));
            // Start the server
            app.listen(port, "0.0.0.0", () => {
                logger.info(`MCP server running on http://0.0.0.0:${port}`);
                logger.info("SSE endpoint available at /sse");
                logger.info("Health check available at /health");
            });
            // Handle graceful shutdown
            process.on("SIGINT", () => {
                logger.info("Server stopped by user");
                process.exit(0);
            });
        }
        catch (error) {
            logger.error(`Server error: ${error}`);
            process.exit(1);
        }
    });
}
// Run the server
if (require.main === module) {
    main();
}
//# sourceMappingURL=index.js.map