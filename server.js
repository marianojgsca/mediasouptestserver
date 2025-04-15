// server.js
const https = require('https');
const fs = require('fs');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');
const mediasoup = require('mediasoup');
const { v4: uuidv4 } = require('uuid');
const redis = require('redis');

const config = require('./config');
const errors = require('./errors');
const RedisManager = require('./RedisManager');
const Room = require('./Room');
const Peer = require('./Peer');

const logger = config.logger;
const instanceId = uuidv4();
logger.info(`--- Starting Mediasoup Server Instance: ${instanceId} ---`);
logger.info(`Log level set to: ${config.logLevel}`);

// --- Global State ---
let workers = [];
let nextWorkerIndex = 0;
const rooms = new Map(); // Map<roomId, Room> - Local room instances
const peers = new Map(); // Map<WebSocket, Peer> - Local peer connections
let redisManager;
let instanceInfoUpdateInterval;
let webSocketPingInterval;
let httpsServer; // Keep server reference for shutdown

// --- Initialization ---
async function initialize() {
    try {
        await runMediasoupWorkers();
        await initializeRedis(); // Sets up redisManager
        await startServers(); // Start HTTPS and WebSocket
        startWebSocketPing(); // Start heartbeat after server starts
        logger.info('Server instance initialization complete.');
    } catch (error) {
        logger.error('*** Server failed to start:', error);
        process.exit(1);
    }
}

async function runMediasoupWorkers() {
    logger.info(`Starting ${config.mediasoup.numWorkers} Mediasoup worker(s)...`);
    for (let i = 0; i < config.mediasoup.numWorkers; i++) {
        try {
            const worker = await mediasoup.createWorker(config.mediasoup.workerSettings);
            const workerPid = worker.pid; // Capture PID before potential closure
            config.metrics.workerStatus.set({ pid: workerPid }, 1); // Initial status OK

            worker.observer.once('close', () => {
                 logger.error(`Mediasoup worker ${workerPid} closed unexpectedly! Exiting.`);
                 config.metrics.workerStatus.set({ pid: workerPid }, 0);
                 process.exit(1);
            });
            worker.on('died', (error) => {
                logger.error(`Mediasoup worker ${workerPid} died:`, error);
                config.metrics.workerStatus.set({ pid: workerPid }, 0);
                process.exit(1);
            });
            workers.push(worker);
            logger.info(`Mediasoup worker ${workerPid} created`);
        } catch (error) {
             logger.error(`Failed to create mediasoup worker ${i}:`, error);
             throw error; // Propagate error to stop initialization
        }
    }
    config.metrics.mediasoupWorkers.set(workers.length); // Set initial worker count metric
}

function getMediasoupWorker() {
    if (workers.length === 0) throw new Error('No Mediasoup workers available');
    const worker = workers[nextWorkerIndex];
    nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
    return worker;
}

async function initializeRedis() {
     const redisOptions = {
         url: `redis://${config.redis.host}:${config.redis.port}`,
         password: config.redis.password,
         socket: { reconnectStrategy: (retries) => Math.min(retries * 50, 2000) }
     };
     const publisher = redis.createClient(redisOptions);
     const subscriber = publisher.duplicate(); // Critical: Use duplicate for subscriptions

     // Setup error handlers *before* connecting
     publisher.on('error', (err) => logger.error('Redis Publisher Error:', err));
     subscriber.on('error', (err) => logger.error('Redis Subscriber Error:', err));

     try {
         await Promise.all([publisher.connect(), subscriber.connect()]);
         logger.info('Connected to Redis successfully.');
         redisManager = new RedisManager({ publisher, subscriber }, instanceId, config); // Initialize the manager

         // Start periodic instance info updates AFTER manager is created
         await redisManager.updateInstanceInfo();
         instanceInfoUpdateInterval = setInterval(
             () => redisManager.updateInstanceInfo(),
             config.redis.instanceExpirySec * 1000 / 2 // Update frequently
         );
     } catch (error) {
         logger.error('Failed to connect to Redis or initialize manager:', error);
         throw error; // Propagate to stop initialization
     }
}

async function startServers() {
    const app = express();
    app.use(express.json());

    // --- Serve Static Files ---
    const publicPath = path.join(__dirname, 'public');
    app.use(express.static(publicPath));
    logger.info(`Serving static files from: ${publicPath}`);

    // --- Health & Metrics Endpoints ---
    app.get('/health', (req, res) => res.status(200).send('OK'));
    app.get('/stats', handleStatsRequest); // Delegate to handler
    app.get('/metrics', async (req, res) => { // Prometheus endpoint
        try {
            // Update gauges before scraping
            config.metrics.connectedPeers.set(peers.size);
            config.metrics.activeRooms.set(rooms.size);
            res.set('Content-Type', config.metricsRegistry.contentType);
            res.end(await config.metricsRegistry.metrics());
        } catch (ex) {
            logger.error("Error generating metrics:", ex);
            res.status(500).end(ex.message);
        }
    });

    // --- Default route for SPA (Optional) ---
    // app.get('*', (req, res) => {
    //    res.sendFile(path.join(publicPath, 'index.html'));
    // });

    try {
        httpsServer = https.createServer({ // Assign to global var
            cert: fs.readFileSync(config.sslCrt),
            key: fs.readFileSync(config.sslKey),
        }, app);

        const wss = new WebSocket.Server({ server: httpsServer });
        wss.on('connection', handleWebSocketConnection); // Attach connection handler

        // Wait for server to actually start listening
        await new Promise((resolve, reject) => {
             httpsServer.once('error', reject); // Handle errors like EADDRINUSE
             httpsServer.listen(config.port, () => {
                 logger.info(`HTTPS server (including static files & WSS) listening on port ${config.port}`);
                 httpsServer.removeListener('error', reject); // Remove error listener on success
                 resolve();
             });
        });
         logger.info('WebSocket upgrade server ready');
         global.wssInstance = wss; // Set global reference for ping interval

    } catch (err) {
        logger.error('--- SERVER STARTUP ERROR (HTTPS/WebSocket):', err.message);
        if (err.code === 'EACCES') logger.error(` Port ${config.port} requires elevated privileges.`);
        if (err.code === 'EADDRINUSE') logger.error(` Port ${config.port} is already in use.`);
        if (err.message.includes('ENOENT')) logger.error(' SSL certificates not found or unreadable.');
        logger.error('---');
        throw err; // Propagate to exit
    }
}

// --- WebSocket Ping ---
function startWebSocketPing() {
    clearInterval(webSocketPingInterval);
    if (!global.wssInstance) {
        logger.warn('WebSocket server not ready, cannot start ping interval.');
        return;
    }
    logger.info(`Starting WebSocket ping interval (${config.webSocket.pingInterval}ms) with timeout ${config.webSocket.timeout}ms`);

    webSocketPingInterval = setInterval(() => {
        const now = Date.now();
        global.wssInstance.clients.forEach((ws) => {
            const peer = peers.get(ws);
            if (!peer) {
                 // Check if socket itself is unresponsive even before peer association
                 if(ws.lastPingTimestamp && now - ws.lastPingTimestamp > config.webSocket.timeout) {
                     logger.warn('Found unresponsive WebSocket without associated peer, terminating.');
                     ws.terminate();
                 } else if (!ws.lastPingTimestamp) {
                     // Send initial ping if no peer yet
                     ws.lastPingTimestamp = now;
                     ws.ping(noop);
                 }
                 return;
            }

            // Check peer liveness based on last pong
            if (now - peer.lastPong > config.webSocket.timeout) {
                logger.warn(`WebSocket TIMEOUT: Peer ${peer.id} is unresponsive. Terminating connection.`);
                handleLeaveRoom(ws, null, 'timeout'); // Trigger cleanup with reason
                // ws.terminate(); // handleLeaveRoom should close/terminate socket
                return;
            }

            // Send ping
            if (ws.readyState === WebSocket.OPEN) {
                 ws.lastPingTimestamp = now; // Track when ping was sent
                 ws.ping(noop); // Send ping (noop is required by ws library)
            }
        });
    }, config.webSocket.pingInterval);
}
function noop() {} // Helper for ws.ping

// --- WebSocket Handling ---
function handleWebSocketConnection(socket) {
    logger.debug(`WebSocket connection established`);
    socket.isAlive = true; // Used by some ping implementations, less reliable than timestamp

    socket.on('pong', () => {
        const peer = peers.get(socket);
        if (peer) {
            peer.pongReceived(); // Update peer's last pong time
        } else {
            // Keep socket alive if pong received before peer fully joined
            socket.isAlive = true;
        }
    });

    socket.on('message', (rawMessage) => handleWebSocketMessage(socket, rawMessage));
    socket.on('close', (code, reason) => handleWebSocketClose(socket, code, reason));
    socket.on('error', (error) => handleWebSocketError(socket, error));
}

async function handleWebSocketMessage(socket, rawMessage) {
    let message;
    let requestId = null;
    const peer = peers.get(socket); // Get associated peer, if any

    try {
        message = JSON.parse(rawMessage);
        requestId = message?.id; // Extract ID after parsing
    } catch (error) {
        return sendJsonRpcError(socket, null, errors.PARSE_ERROR, 'Failed to parse JSON message');
    }

    // Basic JSON-RPC validation
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        return sendJsonRpcError(socket, requestId, errors.INVALID_REQUEST, 'Invalid JSON-RPC request structure');
    }

    // Process the request
    try {
        // Delegate actual method handling
        await handleRpcRequest(socket, message, peer, rooms.get(peer?.roomId));
    } catch (error) {
        const logPrefix = `[ReqID: ${requestId || 'N/A'}] [Peer: ${peer?.id || 'NoPeer'}]`;
        logger.error(`${logPrefix} Unhandled error processing method '${message.method}':`, error);
        // Send structured error back to client
        if (error && typeof error.code === 'number') {
            sendJsonRpcError(socket, requestId, error.code, error.message, error.data);
        } else {
            sendJsonRpcError(socket, requestId, errors.INTERNAL_ERROR, 'Internal server error', error.message);
        }
    }
}

function handleWebSocketClose(socket, code, reason) {
    const peer = peers.get(socket);
    logger.info(`WebSocket connection closed: Peer ${peer?.id || 'N/A'}, Code ${code}, Reason: ${reason?.toString() || 'N/A'}`);
    handleLeaveRoom(socket, null, 'closed'); // Trigger cleanup, pass reason
}

function handleWebSocketError(socket, error) {
    const peer = peers.get(socket);
    logger.error(`WebSocket error: Peer ${peer?.id || 'N/A'}, Error: ${error.message}`);
    handleLeaveRoom(socket, null, 'error'); // Attempt cleanup
}


// --- RPC Request Router ---
async function handleRpcRequest(socket, message, peer, room) {
    const { method, params = {}, id } = message;
    const requestId = id;
    const logPrefix = `[ReqID: ${requestId || 'N/A'}] [Peer: ${peer?.id || 'NoPeer'}] [Method: ${method}]`;

    logger.debug(`${logPrefix} Received request.`);

    // Input Validation Helper
    const requireParams = (required) => {
        for (const param of required) {
            if (params[param] === undefined || params[param] === null) {
                logger.warn(`${logPrefix} Missing required parameter: ${param}`);
                throw errors.createError(errors.INVALID_PARAMS, `Missing required parameter: ${param}`);
            }
            // Add more specific type checks here if needed
        }
    };

    try {
        let result; // Stores result for methods that return one

        // --- Route to specific handlers ---
        if (method === 'getRouterRtpCapabilities') {
             requireParams(['roomId']);
             result = await handleGetRouterRtpCapabilities(socket, requestId, params);
             // This handler sends its own response
        } else if (method === 'joinRoom') {
            if (peer) throw errors.createError(errors.ALREADY_JOINED, 'Already in a room');
             requireParams(['roomId', 'peerId']);
             await handleJoinRoom(socket, requestId, params); // Handles response internally
        } else {
            // Methods requiring peer/room context
            if (!peer) throw errors.createError(errors.NOT_IN_ROOM, 'Must join a room first');
            if (!room || !room.isRouterReady()) {
                logger.error(`${logPrefix} Request invalid: Room ${peer.roomId} not found or router not ready.`);
                peers.delete(socket); // Clean up inconsistent state
                peer.close('Invalid room/router state');
                await redisManager.removePeerFromRoom(peer.roomId, peer.id); // Attempt Redis cleanup
                throw errors.createError(errors.INTERNAL_ERROR, 'Room/Router state invalid, please rejoin');
            }

            switch (method) {
                case 'createWebRtcTransport':
                    requireParams(['direction']);
                    result = await handleCreateWebRtcTransport(peer, room, params); break;
                case 'connectWebRtcTransport':
                    requireParams(['transportId', 'dtlsParameters']);
                    result = await handleConnectWebRtcTransport(peer, room, params); break;
                case 'produce':
                    requireParams(['transportId', 'kind', 'rtpParameters']);
                    result = await handleProduce(peer, room, params); break;
                case 'producerClose':
                    requireParams(['producerId']);
                    result = await handleProducerClose(peer, room, params); break;
                case 'consume':
                    requireParams(['producerPeerId', 'producerId', 'rtpCapabilities', 'transportId']);
                    result = await handleConsume(peer, room, params); break;
                case 'consumerResume':
                    requireParams(['consumerId']);
                    result = await handleConsumerResume(peer, room, params); break;
                case 'leaveRoom':
                    await handleLeaveRoom(socket, requestId); // Handles response internally
                    break; // No result expected here
                default:
                    throw errors.createError(errors.METHOD_NOT_FOUND, `Method not found: ${method}`);
            }
        }

        // Send success response if it wasn't handled internally and had an ID
        if (requestId !== undefined && requestId !== null && result !== undefined) {
            sendJsonRpcSuccess(socket, requestId, result);
        }
        logger.debug(`${logPrefix} Request processed successfully.`);

    } catch (error) {
         logger.warn(`${logPrefix} Error processing request: ${error.message} (Code: ${error.code || 'N/A'})`);
        // Re-throw for central error handling which will send JSON-RPC error response
        throw error;
    }
}


// --- Specific RPC Method Handlers ---

async function handleGetRouterRtpCapabilities(socket, requestId, params) {
    // Note: This requires the room to exist locally. Getting caps from a remote instance
    // would require more complex state sharing or dedicated RPC.
    const room = rooms.get(params.roomId);
    if (!room || !room.isRouterReady()) {
        throw errors.createError(errors.ROOM_NOT_FOUND, 'Room not found locally or router not ready');
    }
    sendJsonRpcSuccess(socket, requestId, room.getRouterRtpCapabilities());
}

async function handleJoinRoom(socket, requestId, params) {
    const { roomId, peerId } = params; // Assumes validation done in handleRpcRequest
    let lockAcquired = false;
    let room = null;
    let peer = null;
    let isNewRoomLocally = false;

    try {
        lockAcquired = await redisManager.acquirePeerLock(roomId, peerId);
        if (!lockAcquired) throw errors.createError(errors.PEER_ID_TAKEN, 'Peer ID potentially in use or join collision');

        room = rooms.get(roomId);
        if (!room) { // If room doesn't exist locally, create it
            logger.info(`Instance ${instanceId}: Creating/loading room ${roomId}`);
            const worker = getMediasoupWorker();
            room = new Room(roomId, worker, redisManager, instanceId);
            await room.ensureRouterReady(); // Wait for router creation
            rooms.set(roomId, room);
            isNewRoomLocally = true;

            // Subscribe to Redis Pub/Sub and update instance tracking
            await redisManager.subscribe(roomId, handleRedisMessage);
            await redisManager.addInstanceToRoom(roomId);
            logger.info(`Instance ${instanceId}: Subscribed to room ${roomId} and updated instance count.`);
        }

        peer = new Peer(peerId, roomId, instanceId, socket, room.router);
        peers.set(socket, peer); // Add to local map

        await room.addPeer(peer); // Add to room's local map
        await redisManager.addPeerToRoom(roomId, peerId); // Add to Redis set

        // Fetch initial state AFTER successfully adding the peer
        const [initialPeers, initialProducers] = await Promise.all([
             redisManager.getRoomPeers(roomId),
             redisManager.getRoomProducers(roomId)
        ]);

        sendJsonRpcSuccess(socket, requestId, {
             peerId: peer.id, routerRtpCapabilities: room.getRouterRtpCapabilities(),
             peers: initialPeers.filter(pId => pId !== peerId),
             producers: initialProducers.filter(p => p.peerId !== peerId),
             instanceId: instanceId,
         });
        logger.info(`Peer ${peerId} successfully joined room ${roomId} on instance ${instanceId}`);

    } catch (error) {
        logger.error(`[ReqID: ${requestId}] Error joining peer ${peerId} to room ${roomId}:`, error);
        // Cleanup
        if (peer && peers.has(socket)) peers.delete(socket);
        if (room && isNewRoomLocally && room._peers.size === 0) { // If created and empty due to failure
             logger.warn(`Cleaning up newly created empty room ${roomId} after join failed.`);
             await redisManager.unsubscribe(roomId);
             const remaining = await redisManager.removeInstanceFromRoom(roomId);
             await redisManager.maybeCleanupRoomKeys(roomId, remaining);
             room.close();
             rooms.delete(roomId);
        }
        // Send specific error if possible, otherwise rethrow wrapped error
        if (error.code && error.message) throw error;
        throw errors.createError(errors.INTERNAL_ERROR, `Failed to join room: ${error.message}`);

    } finally {
         if (lockAcquired) await redisManager.releasePeerLock(roomId, peerId);
    }
}

// Note: Added 'reason' parameter for internal calls
async function handleLeaveRoom(socket, requestId, reason = 'leaveRequest') {
    const peer = peers.get(socket);
    if (!peer) {
        // If called with an ID (meaning explicit request) but no peer found, send error
        if (requestId !== undefined && requestId !== null) {
            sendJsonRpcError(socket, requestId, errors.NOT_IN_ROOM, "Not in a room");
        }
        return; // Nothing to do if peer doesn't exist locally
    }

    const roomId = peer.roomId;
    const peerId = peer.id;
    const room = rooms.get(roomId);

    logger.info(`Peer ${peerId} leaving room ${roomId}. Reason: ${reason}`);
    peers.delete(socket); // Remove mapping first

    await redisManager.releasePeerLock(roomId, peerId); // Release lock if held

    if (!room) {
        logger.warn(`Peer ${peerId} existed, but room ${roomId} was not found locally during leave.`);
        peer.close(`Room ${roomId} not found locally`); // Close peer resources anyway
        await redisManager.removePeerFromRoom(roomId, peerId); // Attempt Redis cleanup
        return;
    }

    try {
        await room.removePeer(peerId); // Handles local peer resource cleanup
        await redisManager.removePeerFromRoom(roomId, peerId); // Remove from Redis set

        if (room._peers.size === 0) { // Check if room is now empty locally
            logger.info(`Room ${roomId} is now empty on instance ${instanceId}. Cleaning up Redis refs.`);
            await redisManager.unsubscribe(roomId);
            const remainingCount = await redisManager.removeInstanceFromRoom(roomId);
            await redisManager.maybeCleanupRoomKeys(roomId, remainingCount); // Check if global cleanup needed

            room.close(); // Close local room object
            rooms.delete(roomId);
            logger.info(`Room ${roomId} closed and removed locally.`);
        }

        if (requestId !== undefined && requestId !== null) {
            sendJsonRpcSuccess(socket, requestId, { left: true });
        }
    } catch (error) {
         logger.error(`[ReqID: ${requestId}] Error during leave cleanup for peer ${peerId} in room ${roomId}:`, error);
         // Ensure room is closed if it exists and became empty due to error
         if (room && !room.closed && room._peers.size === 0) {
             room.close();
             rooms.delete(roomId);
         }
         // If request had ID, throw error for central handler to respond
         if (requestId !== undefined && requestId !== null) {
              throw errors.createError(errors.INTERNAL_ERROR, `Error leaving room: ${error.message}`);
         }
    } finally {
        // Close the socket connection if it's still open
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
             socket.terminate(); // Use terminate for forceful close after leave logic
        }
    }
}

async function handleCreateWebRtcTransport(peer, room, params) {
    const transport = await room.createWebRtcTransport(peer.id, params.direction);
    return {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters
    };
}

async function handleConnectWebRtcTransport(peer, room, params) {
    // connectWebRtcTransport is now part of Room class for better encapsulation
    await room.connectWebRtcTransport(peer.id, params.transportId, params.dtlsParameters);
    return { connected: true };
}

async function handleProduce(peer, room, params) {
    return room.createProducer(peer.id, params.transportId, params.kind, params.rtpParameters, params.appData || {});
}

async function handleProducerClose(peer, room, params) {
    await room.closeProducer(peer.id, params.producerId);
    return { closed: true };
}

async function handleConsume(peer, room, params) {
    return room.createConsumer(peer.id, params.producerPeerId, params.producerId, params.rtpCapabilities, params.transportId);
}

async function handleConsumerResume(peer, room, params) {
    return room.resumeConsumer(peer.id, params.consumerId);
}

// --- Stats Endpoint Handler ---
async function handleStatsRequest(req, res) {
    try {
        const localRoomInfos = Array.from(rooms.values()).map(r => r.getRoomInfo());
        let redisStats = {};
        if (redisManager?.isReady) {
             try {
                // Example: Get total # of peers across all rooms known to Redis (approx)
                // const roomKeys = await redisManager.getKeysPattern(config.redis.roomPrefix + '*:' + config.redis.getKeys('').peers);
                // let totalPeers = 0;
                // for (const key of roomKeys) { totalPeers += await redisManager.getSetCount(key); }
                redisStats = { redisReady: true /*, globalPeerEstimate: totalPeers */ };
             } catch (e) { redisStats = { redisReady: false, error: e.message }; }
        } else {
             redisStats = { redisReady: false };
        }

        res.json({
            instanceId,
            workerPids: workers.map(w => w.pid),
            localPeerCount: peers.size,
            localRoomCount: rooms.size,
            rooms: localRoomInfos,
            redis: redisStats,
            memoryUsage: process.memoryUsage(),
        });
    } catch (error) {
        logger.error("Error generating stats:", error);
        res.status(500).json({ error: "Failed to generate stats" });
    }
}

// --- JSON-RPC Helpers ---
function sendJsonRpcSuccess(socket, id, result) {
    if (socket.readyState !== WebSocket.OPEN || id === undefined || id === null) return;
    const message = { jsonrpc: '2.0', id: id, result: result };
    try { socket.send(JSON.stringify(message)); }
    catch (error) { logger.error(`[ReqID: ${id}] Error sending JSON-RPC success:`, error); }
}

function sendJsonRpcError(socket, id, code, message, data) {
     if (socket.readyState !== WebSocket.OPEN) return;
    const errorResponse = { jsonrpc: '2.0', id: id, error: { code: code, message: message } };
    if (data !== undefined) errorResponse.error.data = data;
    try { socket.send(JSON.stringify(errorResponse)); }
    catch (error) { logger.error(`[ReqID: ${id}] Error sending JSON-RPC error:`, error); }
}


// --- Graceful Shutdown ---
async function shutdown() {
    logger.warn('--- Initiating graceful shutdown ---');
    clearInterval(instanceInfoUpdateInterval);
    clearInterval(webSocketPingInterval);

    // 1. Stop accepting new HTTP/WebSocket connections
    if (httpsServer) {
         httpsServer.close(() => logger.info('HTTPS server closed.'));
    }
     if (global.wssInstance) {
         global.wssInstance.close(() => logger.info('WebSocket server closed.'));
         // Prevent new connections during shutdown
         global.wssInstance.clients.forEach(ws => ws.terminate());
     }


    // 2. Notify peers and trigger leaveRoom for cleanup
    logger.info(`Notifying and disconnecting ${peers.size} peers...`);
    const leavePromises = [];
    peers.forEach((peer, socket) => {
         try {
            peer.notify('serverShutdown', { reason: 'Server is shutting down' });
            leavePromises.push(
                new Promise(resolve => setTimeout(resolve, 50)) // Short delay
                    .then(() => handleLeaveRoom(socket, null, 'shutdown')) // Use async handler
                    .catch(e => logger.error(`Error during shutdown leave for peer ${peer?.id}: ${e.message}`))
            );
         } catch (e){ logger.error(`Error during shutdown notification for peer ${peer?.id}: ${e.message}`) }
    });
    await Promise.allSettled(leavePromises); // Wait for leave processing
    logger.info('Peer disconnection process complete.');

    // Rooms map should be empty now if leave logic worked correctly

    // 3. Clean up this instance's info from Redis
    if (redisManager) await redisManager.removeInstanceInfo();

    // 4. Close Redis connections
    if (redisManager) await redisManager.quit();

    // 5. Close Mediasoup workers
    logger.info('Closing Mediasoup workers...');
    await Promise.allSettled(workers.map(w => {
        config.metrics.workerStatus.set({ pid: w.pid }, 0);
        return w.close();
    }));
    logger.info('Mediasoup workers closed.');

    logger.warn('--- Shutdown complete ---');
    setTimeout(() => process.exit(0), 500);
}

// --- Process Event Listeners ---
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (error, origin) => {
    logger.error('!!! UNCAUGHT EXCEPTION:', error, 'Origin:', origin);
    // In production, you might want to attempt graceful shutdown before exiting
    // shutdown().catch(() => {}).finally(() => process.exit(1));
    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    logger.error('!!! UNHANDLED REJECTION:', reason);
    // Decide whether to exit based on the reason
});


// --- Start the Server ---
initialize(); // Entry point