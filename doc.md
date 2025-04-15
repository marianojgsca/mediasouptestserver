Okay, here are the complete, consolidated files for the Mediasoup server project, incorporating all the improvements and features discussed.

**Project Structure:**

```
mediasoup-server-docker/
├── certs/
├── node_modules/
├── public/
│   ├── index.html
│   ├── style.css
│   └── client.js
├── .env                 <-- EDIT MEDIASOUP_ANNOUNCED_IP HERE!
├── config.js
├── errors.js
├── RedisManager.js
├── Peer.js
├── Room.js
├── server.js
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---
**1. `package.json`**
```json
{
  "name": "mediasoup-server-prod-v4",
  "version": "1.3.0",
  "description": "Production Mediasoup server: JSON-RPC, Redis, pipeToRouter, Metrics, Resilience",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon --inspect server.js",
    "generate-certs": "mkdir -p certs && openssl req -x509 -newkey rsa:4096 -keyout certs/key.pem -out certs/cert.pem -sha256 -days 365 -nodes -subj '/CN=localhost'"
  },
  "author": "",
  "license": "ISC",
  "dependencies": {
    "async-retry": "^1.3.3",
    "dotenv": "^16.3.1",
    "express": "^4.18.2",
    "mediasoup": "^3.12.8",
    "prom-client": "^15.0.0",
    "redis": "^4.6.7",
    "uuid": "^9.0.0",
    "ws": "^8.13.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}
```

---
**2. `.env`**

**(Remember to set `MEDIASOUP_ANNOUNCED_IP` correctly!)**

```ini
# Server configuration
NODE_ENV=production
PORT=3000 # Must match the port mapping in docker-compose.yml
HTTPS_CERT_FULLCHAIN=./certs/cert.pem
HTTPS_CERT_PRIVKEY=./certs/key.pem

# Mediasoup settings
MEDIASOUP_LISTEN_IP=0.0.0.0 # Listen on all interfaces inside the container

# --- IMPORTANT: Set MEDIASOUP_ANNOUNCED_IP ---
# If testing locally (browser on the same machine as Docker):
MEDIASOUP_ANNOUNCED_IP=127.0.0.1
# If testing from another device on your LAN:
# MEDIASOUP_ANNOUNCED_IP=YOUR_HOST_LAN_IP # e.g., 192.168.1.100
# If deploying to a server with a public IP:
# MEDIASOUP_ANNOUNCED_IP=YOUR_SERVER_PUBLIC_IP

MEDIASOUP_RTC_MIN_PORT=10000 # Changed range to avoid potential Windows conflicts
MEDIASOUP_RTC_MAX_PORT=10999 # Changed range
MEDIASOUP_INITIAL_AVAILABLE_OUTGOING_BITRATE=1000000

# Redis configuration
REDIS_HOST=redis # Docker Compose service name
REDIS_PORT=6379
# REDIS_PASSWORD=your_password
# REDIS_DB=0
REDIS_INSTANCE_EXPIRY_SEC=60
REDIS_ROOM_PREFIX=ms:room:
REDIS_INSTANCE_PREFIX=ms:instance:
REDIS_CHANNEL_PREFIX=ms:channel:
REDIS_OPERATION_RETRIES=3 # Number of retries for Redis operations

# WebSocket Heartbeat (milliseconds)
WEBSOCKET_PING_INTERVAL=20000 # Send ping every 20 seconds
WEBSOCKET_TIMEOUT=60000      # Terminate if no pong within 60 seconds (ping interval + grace)

# Logging Level ('debug', 'info', 'warn', 'error')
LOG_LEVEL=info
```

---
**3. `config.js`**
```javascript
// config.js
require('dotenv').config();
const os = require('os');
const mediasoup = require('mediasoup');
const promClient = require('prom-client'); // Prometheus client

// --- Logger Setup ---
const logLevels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLogLevel = logLevels[process.env.LOG_LEVEL?.toLowerCase()] ?? logLevels.info;
const logger = {
    debug: (...args) => { if (currentLogLevel <= logLevels.debug) console.debug(`[${new Date().toISOString()}] [DEBUG]`, ...args); },
    info: (...args) => { if (currentLogLevel <= logLevels.info) console.info(`[${new Date().toISOString()}] [INFO]`, ...args); },
    warn: (...args) => { if (currentLogLevel <= logLevels.warn) console.warn(`[${new Date().toISOString()}] [WARN]`, ...args); },
    error: (...args) => { if (currentLogLevel <= logLevels.error) console.error(`[${new Date().toISOString()}] [ERROR]`, ...args); },
};

// --- Prometheus Metrics Setup ---
promClient.collectDefaultMetrics(); // Collect default Node.js metrics
const registry = promClient.register;
const metrics = {
    connectedPeers: new promClient.Gauge({ name: 'mediasoup_peers_connected_total', help: 'Total number of currently connected peers' }),
    activeRooms: new promClient.Gauge({ name: 'mediasoup_rooms_active_total', help: 'Total number of active rooms managed by this instance' }),
    mediasoupWorkers: new promClient.Gauge({ name: 'mediasoup_workers_active_total', help: 'Total number of active mediasoup workers' }),
    workerStatus: new promClient.Gauge({ name: 'mediasoup_worker_status', help: 'Status of individual mediasoup workers (1=OK, 0=Died)', labelNames: ['pid'] }),
};


module.exports = {
    logLevel: process.env.LOG_LEVEL || 'info',
    logger: logger,

    // Server settings
    port: parseInt(process.env.PORT || 3000),
    sslCrt: process.env.HTTPS_CERT_FULLCHAIN || './certs/cert.pem',
    sslKey: process.env.HTTPS_CERT_PRIVKEY || './certs/key.pem',

    // WebSocket Settings
    webSocket: {
        pingInterval: parseInt(process.env.WEBSOCKET_PING_INTERVAL || 20000),
        timeout: parseInt(process.env.WEBSOCKET_TIMEOUT || 60000),
    },

    // Redis settings
    redis: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        instanceExpirySec: parseInt(process.env.REDIS_INSTANCE_EXPIRY_SEC || 60),
        operationRetries: parseInt(process.env.REDIS_OPERATION_RETRIES || 3), // Retries for operations
        // Prefixes & Key Generation
        roomPrefix: process.env.REDIS_ROOM_PREFIX || 'ms:room:',
        instancePrefix: process.env.REDIS_INSTANCE_PREFIX || 'ms:instance:',
        channelPrefix: process.env.REDIS_CHANNEL_PREFIX || 'ms:channel:',
        keySeparator: ':',
        getKeys: function(roomId) {
            const roomBase = `${this.roomPrefix}${roomId}${this.keySeparator}`;
            return {
                peers: `${roomBase}peers`,           // SET of peerIds
                producers: `${roomBase}producers`,     // HASH <producerId, producerInfoJson>
                instances: `${roomBase}instances`,     // SET of instanceIds
                instanceCount: `${roomBase}instance_count`, // STRING (counter)
            };
        },
        getInstanceKey: function(instanceId) {
            return `${this.instancePrefix}${instanceId}`;
        },
        getPeerKey: function(roomId, peerId) { // Used for temporary lock/presence during join
             return `${this.roomPrefix}${roomId}${this.keySeparator}peerlock:${peerId}`;
        },
        getRoomChannel: function(roomId) {
             return `${this.channelPrefix}${roomId}`;
        }
    },

    // Mediasoup settings
    mediasoup: {
        numWorkers: Math.min(os.cpus().length, 4), // Limit workers for typical scenarios
        workerSettings: {
            logLevel: process.env.NODE_ENV === 'production' ? 'warn' : 'debug',
            logTags: [
                'info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp',
                'rtx', 'bwe', 'score', 'simulcast', 'svc', 'sctp'
            ],
            rtcMinPort: parseInt(process.env.MEDIASOUP_RTC_MIN_PORT || 10000), // Use updated default
            rtcMaxPort: parseInt(process.env.MEDIASOUP_RTC_MAX_PORT || 10999), // Use updated default
        },
        routerOptions: {
            mediaCodecs: [
                { kind:'audio', mimeType:'audio/opus', clockRate:48000, channels:2 },
                { kind:'video', mimeType:'video/VP8', clockRate:90000, parameters:{ 'x-google-start-bitrate': 1000 } },
                { kind:'video', mimeType:'video/VP9', clockRate:90000, parameters:{ 'profile-id': 2, 'x-google-start-bitrate': 1000 } },
                { kind:'video', mimeType:'video/h264', clockRate:90000, parameters:{ 'packetization-mode': 1, 'profile-level-id': '4d0032', 'level-asymmetry-allowed': 1, 'x-google-start-bitrate': 1000 } },
                { kind:'video', mimeType:'video/h264', clockRate:90000, parameters:{ 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1, 'x-google-start-bitrate': 1000 } }
            ],
            appData: {}
        },
        webRtcTransportOptions: {
            listenInfos: [
                { protocol: 'udp', ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0', announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP },
                { protocol: 'tcp', ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0', announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP }
            ],
            enableUdp: true, enableTcp: true, preferUdp: true,
            initialAvailableOutgoingBitrate: parseInt(process.env.MEDIASOUP_INITIAL_AVAILABLE_OUTGOING_BITRATE || 1000000),
            appData: {}
        },
        // PipeTransport options: Use WebRTC transport options for listening IPs
        pipeTransportOptions: {
           listenInfo: { // Simplified: Assume one listen interface for pipes per instance
                 protocol : 'udp',
                 ip       : process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
                 // Announced IP will be the instance's announced IP
                 // Port will be dynamic
             },
            enableSctp: false, // Usually not needed for piping media
            numSctpStreams: { OS: 0, MIS: 0 },
            enableRtx: true,
            enableSrtp: true,
            appData: { type: 'pipe' }
        }
    },

    // Prometheus Metrics Registry
    metricsRegistry: registry,
    metrics: metrics,
};
```

---
**4. `errors.js`**
```javascript
// errors.js

// Standard JSON-RPC 2.0 Error Codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// -32000 to -32099: Reserved for implementation-defined server-errors.
// Custom Application Error Codes within this range
const ROOM_NOT_FOUND = -32000;
const PEER_NOT_FOUND = -32001;
const ALREADY_JOINED = -32002;
const NOT_IN_ROOM = -32003;
const TRANSPORT_NOT_FOUND = -32004;
const PRODUCER_NOT_FOUND = -32005;
const CONSUMER_NOT_FOUND = -32006;
const MEDIASOUP_ERROR = -32007;   // Generic mediasoup operation error
const INVALID_STATE = -32008;     // e.g., trying to produce on recv transport
const PERMISSION_DENIED = -32009; // For potential future authorization checks
const PEER_ID_TAKEN = -32010;     // Peer ID already exists in the room (Redis check)
const INVALID_PRODUCER_OWNER = -32011; // Mismatch during consume request
const PIPING_ERROR = -32012;      // Error related to pipeToRouter operations

/**
 * Helper function to create structured JSON-RPC 2.0 error objects.
 * @param {number} code - The JSON-RPC error code.
 * @param {string} message - A human-readable error message.
 * @param {any} [data] - Optional data associated with the error.
 * @returns {{code: number, message: string, data?: any, _stack?: string}} The error object.
 */
function createError(code, message, data) {
    const err = { code, message };
    if (data !== undefined) {
        err.data = data;
    }
    // Attach stack in non-production for easier debugging server-side
    if (process.env.NODE_ENV !== 'production') {
        // Capture stack trace excluding this function call itself
        const stackHolder = {};
        Error.captureStackTrace(stackHolder, createError);
        err._stack = stackHolder.stack;
    }
    return err;
}

module.exports = {
    // Standard codes
    PARSE_ERROR,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    INVALID_PARAMS,
    INTERNAL_ERROR,
    // Custom codes
    ROOM_NOT_FOUND,
    PEER_NOT_FOUND,
    ALREADY_JOINED,
    NOT_IN_ROOM,
    TRANSPORT_NOT_FOUND,
    PRODUCER_NOT_FOUND,
    CONSUMER_NOT_FOUND,
    MEDIASOUP_ERROR,
    INVALID_STATE,
    PERMISSION_DENIED,
    PEER_ID_TAKEN,
    INVALID_PRODUCER_OWNER,
    PIPING_ERROR,
    // Helper
    createError,
};
```

---
**5. `RedisManager.js`**
```javascript
// RedisManager.js
const retry = require('async-retry');
const errors = require('./errors');

/**
 * Manages interactions with Redis for storing and retrieving room/peer/producer state.
 */
class RedisManager {
    #publisher;
    #subscriber;
    #instanceId;
    #config;
    #logger;
    #isReady = false;
    #retryOptions;

    /**
     * Creates an instance of RedisManager.
     * @param {object} redisClients - Object containing connected 'publisher' and 'subscriber' redis clients (node-redis v4+).
     * @param {string} instanceId - Unique ID of this server instance.
     * @param {object} config - Server configuration object.
     */
    constructor(redisClients, instanceId, config) {
        if (!redisClients.publisher || !redisClients.subscriber) {
            throw new Error('RedisManager requires connected publisher and subscriber clients.');
        }
        this.#publisher = redisClients.publisher;
        this.#subscriber = redisClients.subscriber; // Needed for subscribe/unsubscribe actions
        this.#instanceId = instanceId;
        this.#config = config;
        this.#logger = config.logger;
        this.#retryOptions = {
            retries: this.#config.redis.operationRetries,
            factor: 1.2, // Exponential backoff factor
            minTimeout: 50, // Minimum delay
            maxTimeout: 500, // Maximum delay
            onRetry: (error, attempt) => {
                this.#logger.warn(`Redis operation failed (attempt ${attempt}/${this.#retryOptions.retries + 1}), retrying: ${error.message}`);
            },
        };
        this._setupListeners(); // Setup listeners after clients are assigned
        this.#isReady = this.#publisher.isReady && this.#subscriber.isReady;
        this.#logger.info(`RedisManager initialized for instance ${instanceId}. Ready: ${this.#isReady}`);
    }

    _setupListeners() {
        const setupClientListeners = (client, name) => {
            client.on('ready', () => {
                this.#isReady = this.#publisher.isReady && this.#subscriber.isReady;
                // Only log manager ready state once
                if (this.#isReady && name === 'Publisher') this.#logger.info(`RedisManager is ready.`);
                this.#logger.info(`Redis ${name} ready.`);
            });
             client.on('end', () => {
                 this.#isReady = false;
                 this.#logger.warn(`Redis ${name} connection closed.`);
             });
            client.on('error', (err) => {
                this.#isReady = false; // Mark as not ready on error
                // Error logged by server.js Redis setup
            });
        };
        setupClientListeners(this.#publisher, 'Publisher');
        setupClientListeners(this.#subscriber, 'Subscriber');
    }

    get isReady() {
        // Ensure clients themselves report ready state
        return this.#isReady && this.#publisher.isReady && this.#subscriber.isReady;
    }

    /** Internal helper to execute Redis commands with retry logic. */
    async #doRedisOp(operationName, commandExecutor) {
        if (!this.isReady) {
            throw errors.createError(errors.INTERNAL_ERROR, 'Redis is not available');
        }
        try {
            return await retry(async (bail, attempt) => {
                 if (!this.isReady) {
                     bail(new Error('Redis became unavailable during operation'));
                     return;
                 }
                try {
                    // Pass publisher client to the executor function
                    return await commandExecutor(this.#publisher);
                } catch (error) {
                    // Retry common network/transient errors
                    if (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED' || error.code === 'ENOTCONN' || error.message.includes('LOADING') || error.message.includes('closed')) {
                        this.#logger.warn(`Retrying Redis operation '${operationName}' (attempt ${attempt}) after error: ${error.message}`);
                        throw error; // Throw to trigger retry
                    } else {
                        this.#logger.error(`Unrecoverable Redis error during '${operationName}':`, error);
                        bail(error); // Stop retrying for other errors
                        return;
                    }
                }
            }, this.#retryOptions);
        } catch (error) {
            this.#logger.error(`Redis operation '${operationName}' failed after ${this.#retryOptions.retries} retries:`, error);
            throw errors.createError(errors.INTERNAL_ERROR, `Redis operation '${operationName}' failed: ${error.message}`);
        }
    }


    // --- Instance Info ---
    async updateInstanceInfo() {
        if (!this.#publisher || !this.#publisher.isReady) return; // Check publisher specifically
        const instanceKey = this.#config.redis.getInstanceKey(this.#instanceId);
        const instanceData = {
            instanceId: this.#instanceId,
            pipeListenIp: this.#config.mediasoup.webRtcTransportOptions.listenInfos[0].announcedIp,
            updatedAt: Date.now(),
        };
        try {
            await this.#publisher.set(instanceKey, JSON.stringify(instanceData), { EX: this.#config.redis.instanceExpirySec });
        } catch (error) { this.#logger.error(`Redis SET error for instance key ${instanceKey}:`, error); }
    }

    async removeInstanceInfo() {
        if (!this.#publisher || !this.#publisher.isReady) return;
        const instanceKey = this.#config.redis.getInstanceKey(this.#instanceId);
        try { await this.#publisher.del(instanceKey); }
        catch (error) { this.#logger.error(`Redis DEL error for instance key ${instanceKey}:`, error); }
    }

    // --- Peer Lock ---
    async acquirePeerLock(roomId, peerId) {
        const key = this.#config.redis.getPeerKey(roomId, peerId);
        const setResult = await this.#doRedisOp('acquirePeerLock', client =>
            client.set(key, this.#instanceId, { NX: true, EX: 10 })
        );
        return setResult === 'OK';
    }

    async releasePeerLock(roomId, peerId) {
        if (!this.#publisher || !this.#publisher.isReady) return;
        const key = this.#config.redis.getPeerKey(roomId, peerId);
        try { await this.#publisher.del(key); }
        catch (error) { this.#logger.error(`Redis DEL error for peer lock key ${key}:`, error); }
    }

    // --- Room State (Peers & Producers) ---
    async addPeerToRoom(roomId, peerId) {
        const keys = this.#config.redis.getKeys(roomId);
        await this.#doRedisOp('addPeerToRoom', client => client.sAdd(keys.peers, peerId));
    }

    async removePeerFromRoom(roomId, peerId) {
        if (!this.#publisher || !this.#publisher.isReady) return;
        const keys = this.#config.redis.getKeys(roomId);
        try { await this.#publisher.sRem(keys.peers, peerId); }
        catch (error) { this.#logger.error(`Redis SREM error for room ${roomId}, peer ${peerId}:`, error); }
    }

    async getRoomPeers(roomId) {
        const keys = this.#config.redis.getKeys(roomId);
        return this.#doRedisOp('getRoomPeers', client => client.sMembers(keys.peers));
    }

    async addProducerToRoom(roomId, producerId, producerInfo) {
        const keys = this.#config.redis.getKeys(roomId);
        await this.#doRedisOp('addProducerToRoom', client => client.hSet(keys.producers, producerId, JSON.stringify(producerInfo)));
    }

    async removeProducerFromRoom(roomId, producerId) {
        if (!this.#publisher || !this.#publisher.isReady) return;
        const keys = this.#config.redis.getKeys(roomId);
        try { await this.#publisher.hDel(keys.producers, producerId); }
        catch (error) { this.#logger.error(`Redis HDEL error for room ${roomId}, producer ${producerId}:`, error); }
    }

    async getRoomProducers(roomId) {
        const keys = this.#config.redis.getKeys(roomId);
        const producersMap = await this.#doRedisOp('getRoomProducers', client => client.hGetAll(keys.producers));
        try {
            return Object.values(producersMap).map(pJson => JSON.parse(pJson));
        } catch (parseError) {
            this.#logger.error(`Error parsing producer data for room ${roomId}:`, parseError);
            return [];
        }
    }

     async getProducerInfo(roomId, producerId) {
        const keys = this.#config.redis.getKeys(roomId);
        const infoJson = await this.#doRedisOp('getProducerInfo', client => client.hGet(keys.producers, producerId));
        try {
            return infoJson ? JSON.parse(infoJson) : null;
        } catch (parseError) {
             this.#logger.error(`Error parsing producer info for ${producerId} in room ${roomId}:`, parseError);
             return null;
        }
    }


    // --- Room Instance Tracking ---
    async addInstanceToRoom(roomId) {
        const keys = this.#config.redis.getKeys(roomId);
        await this.#doRedisOp('addInstanceToRoom', async (client) => {
            const multi = client.multi();
            multi.sAdd(keys.instances, this.#instanceId);
            multi.incr(keys.instanceCount);
            return multi.exec();
        });
    }

    async removeInstanceFromRoom(roomId) {
        if (!this.isReady) return 0;
        const keys = this.#config.redis.getKeys(roomId);
        let remainingCount = 0;
        try {
            const results = await this.#doRedisOp('removeInstanceFromRoom', async (client) => {
                 const multi = client.multi();
                 multi.sRem(keys.instances, this.#instanceId);
                 multi.decr(keys.instanceCount);
                 return multi.exec();
            });
            // Ensure result array exists and has expected length
            remainingCount = (results && results.length > 1 && typeof results[1] === 'number') ? results[1] : 0;

            if (remainingCount < 0) {
                this.#logger.warn(`Room ${roomId} instance count went below zero (${remainingCount}), resetting to 0.`);
                try { await this.#publisher.set(keys.instanceCount, 0); } catch { /* ignore */ }
                remainingCount = 0;
            }
        } catch (error) {
             // Error already logged by doRedisOp
             remainingCount = await this.getRoomInstanceCount(roomId); // Fallback
        }
        return remainingCount;
    }

    async getRoomInstanceCount(roomId) {
        if (!this.isReady) return 0;
        const keys = this.#config.redis.getKeys(roomId);
        try {
             const countStr = await this.#doRedisOp('getRoomInstanceCount', client => client.get(keys.instanceCount));
             return parseInt(countStr || '0');
        } catch { return 0; }
    }

    async maybeCleanupRoomKeys(roomId, currentInstanceCount) {
        if (!this.isReady) return;
        if (currentInstanceCount <= 0) {
            this.#logger.warn(`Room ${roomId}: Last known instance left. Attempting to delete global room keys.`);
            const keys = this.#config.redis.getKeys(roomId);
            const keysToDelete = [ keys.instances, keys.instanceCount, keys.peers, keys.producers ];
            try {
                await this.#publisher.del(keysToDelete); // No retry on cleanup DEL
                this.#logger.info(`Room ${roomId}: Successfully deleted global keys.`);
            } catch (error) { this.#logger.error(`Redis DEL error during room ${roomId} cleanup:`, error); }
        }
    }

    // --- Pub/Sub ---
    async subscribe(roomId, handler) {
        if (!this.#subscriber || !this.#subscriber.isReady) {
            throw errors.createError(errors.INTERNAL_ERROR, 'Redis subscriber not available');
        }
        const channel = this.#config.redis.getRoomChannel(roomId);
        try {
            await this.#subscriber.subscribe(channel, handler);
            this.#logger.info(`Subscribed to Redis channel: ${channel}`);
        } catch (error) {
            this.#logger.error(`Redis SUBSCRIBE error for channel ${channel}:`, error);
            throw errors.createError(errors.INTERNAL_ERROR, 'Redis error subscribing');
        }
    }

    async unsubscribe(roomId) {
        if (!this.#subscriber || !this.#subscriber.isReady) return;
        const channel = this.#config.redis.getRoomChannel(roomId);
        try { await this.#subscriber.unsubscribe(channel); }
        catch (error) { this.#logger.error(`Redis UNSUBSCRIBE error for channel ${channel}:`, error); }
    }

    async publish(roomId, eventType, payload) {
        if (!this.isReady) {
            this.#logger.warn(`Cannot publish event ${eventType} to room ${roomId}, Redis not ready.`);
            return;
        }
        const channel = this.#config.redis.getRoomChannel(roomId);
        const message = JSON.stringify({
            senderInstanceId: this.#instanceId,
            type: eventType,
            payload: payload,
        });
        try { await this.#publisher.publish(channel, message); } // No retry on publish
        catch (error) { this.#logger.error(`Redis PUBLISH error to channel ${channel}:`, error); }
    }

     // --- Cleanup ---
     async quit() {
        this.#logger.warn('Closing Redis connections...');
        // Use Promise.allSettled to ensure both quits are attempted
        const results = await Promise.allSettled([
            this.#publisher?.quit(),
            this.#subscriber?.quit()
        ]);
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                this.#logger.error(`Error closing Redis ${index === 0 ? 'publisher' : 'subscriber'}:`, result.reason);
            }
        });
        this.#isReady = false; // Mark as not ready after quit attempts
        this.#logger.info('Redis quit commands sent.');
     }
}

module.exports = RedisManager;
```

---
**6. `Peer.js`**
```javascript
// Peer.js
const config = require('./config');
const errors = require('./errors');
const logger = config.logger;

/**
 * Represents a client connection within a room, managing its state and Mediasoup objects.
 */
class Peer {
    /** Unique identifier for the peer. */
    id;
    /** ID of the room this peer belongs to. */
    roomId;
    /** ID of the server instance handling this peer's WebSocket. */
    instanceId;
    /** The WebSocket connection object. */
    _socket;
    /** The Mediasoup router associated with this peer's room. */
    _mediasoupRouter;
    /** Map of Mediasoup transports associated with this peer. <transportId, Transport> */
    _transports = new Map();
    /** Map of Mediasoup producers created by this peer. <producerId, Producer> */
    _producers = new Map();
    /** Map of Mediasoup consumers created for this peer. <consumerId, Consumer> */
    _consumers = new Map();
    /** Map of pending consume requests waiting for pipe producer creation. <producerId, { resolve, reject, timeoutId }> */
    _pendingConsumePipes = new Map();
    /** Flag indicating if the WebSocket connection is considered alive (based on pongs). */
    isAlive = true;
    /** Timestamp of the last received WebSocket pong message. */
    lastPong = Date.now();

    /**
     * Creates a Peer instance.
     * @param {string} peerId Unique Peer ID.
     * @param {string} roomId Room ID.
     * @param {string} instanceId Server instance ID.
     * @param {WebSocket} socket The WebSocket connection.
     * @param {mediasoup.types.Router} mediasoupRouter The room's router.
     */
    constructor(peerId, roomId, instanceId, socket, mediasoupRouter) {
        this.id = peerId;
        this.roomId = roomId;
        this.instanceId = instanceId;
        this._socket = socket;
        this._mediasoupRouter = mediasoupRouter;
        this.lastPong = Date.now();
        logger.info(`Peer created: ${this.id} in room ${this.roomId} on instance ${this.instanceId}`);
    }

    // --- Getters ---
    get socket() { return this._socket; }
    get router() { return this._mediasoupRouter; }
    getTransport(id) { return this._transports.get(id); }
    getProducer(id) { return this._producers.get(id); }
    getConsumer(id) { return this._consumers.get(id); }
    getAllProducers() { return Array.from(this._producers.values()); }
    getAllConsumers() { return Array.from(this._consumers.values()); }

    // --- Mediasoup Object Management ---
    /** Adds a transport and sets up listeners for its closure. */
    addTransport(transport) {
        this._transports.set(transport.id, transport);
        logger.debug(`Peer ${this.id}: Transport added ${transport.id} (${transport.appData.transportType})`);
        // Use observer 'close' for guaranteed cleanup notification
        transport.observer.once('close', () => {
            logger.debug(`Peer ${this.id}: Transport ${transport.id} observer closed.`);
            this._transports.delete(transport.id);
        });
        transport.on('dtlsstatechange', (state) => {
            if (state === 'failed') logger.warn(`Peer ${this.id}: Transport ${transport.id} DTLS failed`);
        });
    }

    /** Adds a producer and sets up listeners for its closure. */
    addProducer(producer) {
        this._producers.set(producer.id, producer);
        logger.debug(`Peer ${this.id}: Producer added ${producer.id} (kind: ${producer.kind})`);
        producer.observer.once('close', () => {
            logger.debug(`Peer ${this.id}: Producer ${producer.id} observer closed.`);
            this._producers.delete(producer.id);
        });
    }

    /** Adds a consumer and sets up listeners for relevant events. */
    addConsumer(consumer, origin) {
        this._consumers.set(consumer.id, consumer);
        logger.debug(`Peer ${this.id}: Consumer added ${consumer.id} (producerId: ${consumer.producerId}, origin: ${origin})`);

        consumer.observer.once('close', () => {
            logger.debug(`Peer ${this.id}: Consumer ${consumer.id} observer closed.`);
            this._consumers.delete(consumer.id);
        });
        consumer.on('producerclose', () => {
            logger.debug(`Peer ${this.id}: Consumer ${consumer.id}'s producer closed.`);
            this.notify('consumerClosed', { consumerId: consumer.id, reason: 'producerclose' });
            this._consumers.delete(consumer.id); // Ensure cleanup
        });
        consumer.on('producerpause', () => this.notify('consumerPaused', { consumerId: consumer.id }));
        consumer.on('producerresume', () => this.notify('consumerResumed', { consumerId: consumer.id }));
        consumer.on('layerschange', (layers) => this.notify('consumerLayersChanged', { consumerId: consumer.id, layers }));
    }

    /** Closes and removes a specific producer created by this peer. */
    removeProducer(producerId) {
        const producer = this._producers.get(producerId);
        if (producer && !producer.closed) {
            logger.debug(`Peer ${this.id}: Closing producer ${producerId}`);
            producer.close(); // Observer 'close' handles map deletion
        } else if (!producer) {
             logger.warn(`Peer ${this.id}: Attempted to remove non-existent producer ${producerId}`);
        }
    }

    /** Closes and removes a specific consumer created for this peer. */
    removeConsumer(consumerId) {
        const consumer = this._consumers.get(consumerId);
        if (consumer && !consumer.closed) {
            logger.debug(`Peer ${this.id}: Closing consumer ${consumerId}`);
            consumer.close(); // Observer 'close' handles map deletion
        } else if (!consumer) {
             logger.warn(`Peer ${this.id}: Attempted to remove non-existent consumer ${consumerId}`);
        }
    }

    // --- Pipe Request State Management ---
    /**
     * Creates a promise that waits for a pipe producer to become available.
     * Used when consuming a remote producer.
     * @param {string} producerId - The ID of the original remote producer.
     * @returns {Promise<{pipeProducerId: string}>} Resolves with the ID of the locally created pipe producer.
     */
    addPendingConsumePipe(producerId) {
        return new Promise((resolve, reject) => {
            if (this._pendingConsumePipes.has(producerId)) {
                logger.warn(`Peer ${this.id}: Consume request already pending for producer ${producerId}`);
                return reject(errors.createError(errors.INVALID_STATE, `Consume request already pending for producer ${producerId}`));
            }
            const timeoutId = setTimeout(() => {
                 logger.warn(`Peer ${this.id}: Timeout waiting for pipe producer ready for ${producerId}`);
                 this.rejectPendingConsumePipe(producerId, 'Pipe creation timed out');
            }, 30000); // 30s timeout

            this._pendingConsumePipes.set(producerId, { resolve, reject, timeoutId });
            logger.debug(`Peer ${this.id}: Added pending consume pipe request for ${producerId}`);
        });
    }

    /** Resolves a pending consume pipe request. Called when the pipe producer is ready. */
    resolvePendingConsumePipe(producerId, pipeProducerId) {
        const pending = this._pendingConsumePipes.get(producerId);
        if (pending) {
            logger.debug(`Peer ${this.id}: Resolving pending consume pipe for ${producerId} with pipeProducerId ${pipeProducerId}`);
            clearTimeout(pending.timeoutId);
            pending.resolve({ pipeProducerId });
            this._pendingConsumePipes.delete(producerId);
        } else {
             logger.warn(`Peer ${this.id}: No pending consume pipe found for producer ${producerId} to resolve.`);
        }
    }

     /** Rejects a pending consume pipe request. Called on error or timeout. */
     rejectPendingConsumePipe(producerId, reason = 'Unknown reason') {
        const pending = this._pendingConsumePipes.get(producerId);
        if (pending) {
            logger.warn(`Peer ${this.id}: Rejecting pending consume pipe for ${producerId}: ${reason}`);
            clearTimeout(pending.timeoutId);
            const error = (reason instanceof Error && reason.code)
                ? reason // Use existing structured error if available
                : errors.createError(errors.PIPING_ERROR, typeof reason === 'string' ? reason : 'Piping failed');
            pending.reject(error);
            this._pendingConsumePipes.delete(producerId);
        }
    }

    // --- Liveness Check ---
    /** Called when a WebSocket pong is received from this peer. */
    pongReceived() {
        this.lastPong = Date.now();
        this.isAlive = true;
    }

    // --- Peer Close ---
    /** Closes all associated Mediasoup objects and the WebSocket connection. */
    close(reason = 'Peer closed') {
        if (!this.isAlive && reason === 'Peer closed') { // Avoid logging closed twice if already marked dead
             reason = 'Peer unresponsive or closed';
        }
        logger.info(`Closing peer ${this.id}. Reason: ${reason}`);
        this.isAlive = false; // Mark as definitively closed

        // Close transports first - this should cascade close producers/consumers via observers
        this._transports.forEach(t => { if (!t.closed) t.close(); });
        this._transports.clear();
        this._producers.clear(); // Maps cleared after observers fire
        this._consumers.clear();

        // Reject any remaining pending requests
        this._pendingConsumePipes.forEach((req, producerId) => {
            logger.warn(`Peer ${this.id}: Rejecting pending consume pipe for ${producerId} due to peer close.`);
            this.rejectPendingConsumePipe(producerId, `Peer ${this.id} disconnected`);
        });
        this._pendingConsumePipes.clear(); // Ensure map is cleared

        // Terminate WebSocket connection
        if (this._socket.readyState === WebSocket.OPEN || this._socket.readyState === WebSocket.CONNECTING) {
            this._socket.terminate(); // Use terminate for forceful close, esp. if unresponsive
        }
        logger.info(`Peer ${this.id} closed successfully.`);
    }

    // --- JSON-RPC Methods ---
    /** Sends a JSON-RPC success response. */
    sendResponse(id, result) {
        if (this._socket.readyState !== WebSocket.OPEN || id === undefined || id === null) return;
        const message = { jsonrpc: '2.0', id: id, result: result };
        try { this._socket.send(JSON.stringify(message)); }
        catch (error) { logger.error(`Peer ${this.id}: Error sending response:`, error); }
    }

    /** Sends a JSON-RPC error response. */
    sendError(id, code, message, data) {
        if (this._socket.readyState !== WebSocket.OPEN) return;
        logger.warn(`Peer ${this.id}: Sending error response: Code ${code}, Message: ${message}`);
        const errorResponse = { jsonrpc: '2.0', id: id, error: { code: code, message: message } };
        if (data !== undefined) errorResponse.error.data = data;
        try { this._socket.send(JSON.stringify(errorResponse)); }
        catch (error) { logger.error(`Peer ${this.id}: Error sending error response:`, error); }
    }

    /** Sends a JSON-RPC notification. */
    notify(method, params) {
        if (this._socket.readyState !== WebSocket.OPEN) return;
        const notification = { jsonrpc: '2.0', method: method, params: params };
        try { this._socket.send(JSON.stringify(notification)); }
        catch (error) { logger.error(`Peer ${this.id}: Error sending notification ${method}:`, error); }
    }
}

module.exports = Peer;
```

---
**7. `Room.js`**
```javascript
// Room.js
const mediasoup = require('mediasoup');
const config = require('./config');
const Peer = require('./Peer');
const errors = require('./errors');

const logger = config.logger;

/**
 * Manages Mediasoup router, peers, producers, consumers, and piping for a single room
 * on a specific server instance. Interacts with RedisManager for distributed state.
 */
class Room {
    /** Room identifier. */
    id;
    /** Mediasoup router instance for this room. */
    _mediasoupRouter;
    /** Mediasoup worker running the router. */
    _worker;
    /** Map of peers connected to this room on this instance. <peerId, Peer> */
    _peers = new Map();
    /** Map of PipeTransports sending media TO remote instances. <remoteInstanceId, PipeTransport> */
    _outgoingPipeTransports = new Map();
    /** Map of PipeTransports receiving media FROM remote instances. <pipeTransportId, PipeTransport> */
    _incomingPipeTransports = new Map();
    /** Reference to the RedisManager instance. */
    _redisManager;
    /** Unique ID of the server instance managing this Room object. */
    _instanceId;
    /** Promise that resolves when the router is initialized. */
    _routerReadyPromise;

    /**
     * Creates a Room instance.
     * @param {string} roomId Room ID.
     * @param {mediasoup.types.Worker} worker Mediasoup Worker.
     * @param {RedisManager} redisManager RedisManager instance.
     * @param {string} instanceId Server instance ID.
     */
    constructor(roomId, worker, redisManager, instanceId) {
        this.id = roomId;
        this._worker = worker;
        this._redisManager = redisManager;
        this._instanceId = instanceId;
        this._routerReadyPromise = this._initializeRouter();
    }

    /** Initializes the Mediasoup router for the room. */
    async _initializeRouter() {
       try {
            const router = await this._worker.createRouter({
                ...config.mediasoup.routerOptions,
                appData: { roomId: this.id, workerPid: this._worker.pid, instanceId: this._instanceId }
            });
            this._mediasoupRouter = router;
            logger.info(`Room ${this.id}: Router created on worker ${this._worker.pid}, instance ${this._instanceId}`);
            this._mediasoupRouter.observer.once('close', () => {
                 logger.warn(`Room ${this.id}: Router ${this._mediasoupRouter.id} closed`);
                 this._mediasoupRouter = null;
                 this._closeAllPipeTransports(); // Clean up pipes if router closes
            });
            return router;
       } catch (error) {
            logger.error(`Room ${this.id}: Failed to create router:`, error);
            throw errors.createError(errors.MEDIASOUP_ERROR, `Router creation failed: ${error.message}`);
       }
    }

    // --- Getters ---
    get router() { return this._mediasoupRouter; }
    isRouterReady() { return !!this._mediasoupRouter && !this._mediasoupRouter.closed; }
    async ensureRouterReady() {
        if (this.isRouterReady()) return this._mediasoupRouter;
        return this._routerReadyPromise;
    }
    getPeer(peerId) { return this._peers.get(peerId); }
    hasPeer(peerId) { return this._peers.has(peerId); }

    // --- Peer Management ---
    /** Adds a peer to the local map and sets up socket listeners. */
    async addPeer(peer) {
        await this.ensureRouterReady();
        if (this._peers.has(peer.id)) { // Handle rejoin attempt
             logger.warn(`Room ${this.id}: Peer ${peer.id} trying to rejoin, closing old connection.`);
             const existingPeer = this._peers.get(peer.id);
             if (existingPeer && existingPeer.socket !== peer.socket) {
                 existingPeer.close('Replaced by new connection'); // Close old peer/socket
             } else {
                  throw errors.createError(errors.ALREADY_JOINED, "Peer already joined with this connection");
             }
             // Old peer removal will be handled by its 'close' event triggering removePeer()
        }
        this._peers.set(peer.id, peer);
        logger.info(`Room ${this.id}: Peer ${peer.id} added locally.`);

        // Redis state (SADD) and PubSub ('peerJoined') handled in server.js/handleJoinRoom

        peer.socket.on('close', () => this.removePeer(peer.id));
        peer.socket.on('error', (error) => {
             logger.error(`Room ${this.id}: Peer ${peer.id} socket error:`, error);
             this.removePeer(peer.id); // Treat socket error as disconnect
        });
    }

    /** Removes peer locally, closing its producers/consumers. */
    async removePeerLocally(peerId) {
        const peer = this._peers.get(peerId);
        if (!peer) return;
        logger.info(`Room ${this.id}: Removing peer ${peer.id} locally.`);

        // Close local producers first (this also triggers Redis HDEL via closeProducer)
        const producerClosePromises = peer.getAllProducers().map(p => this.closeProducer(peer.id, p.id));
        await Promise.allSettled(producerClosePromises);

        peer.close(`Removing peer ${peerId} from room ${this.id}`); // Close peer resources
        this._peers.delete(peerId);
    }

    /** Handles peer removal triggered by socket close or explicit leave. */
    async removePeer(peerId) {
        if (!this._peers.has(peerId)) return; // Already removed
        logger.info(`Room ${this.id}: Processing removal for peer ${peerId}.`);
        await this.removePeerLocally(peerId);
        // Redis state (SREM) and PubSub ('peerClosed') handled in server.js/handleLeaveRoom
    }

    // --- Producer Management ---
    /** Creates a producer, adds it locally, updates Redis, and notifies peers. */
    async createProducer(peerId, transportId, kind, rtpParameters, appData) {
        await this.ensureRouterReady();
        const peer = this.getPeer(peerId);
        if (!peer) throw errors.createError(errors.PEER_NOT_FOUND, `Peer ${peerId} not found`);
        const transport = peer.getTransport(transportId);
        if (!transport || transport.closed || transport.appData.transportType !== 'send') {
            throw errors.createError(errors.INVALID_STATE, `Send transport ${transportId} invalid or closed`);
        }

        try {
            const producer = await transport.produce({
                kind, rtpParameters,
                appData: { ...appData, peerId: peerId, transportId: transportId, instanceId: this._instanceId }
            });
            peer.addProducer(producer); // Add locally

            const producerInfo = {
                 roomId: this.id, peerId: peerId, producerId: producer.id,
                 kind: producer.kind, type: producer.type, appData: producer.appData,
                 instanceId: this._instanceId,
            };

            await this._redisManager.addProducerToRoom(this.id, producer.id, producerInfo);
            await this._redisManager.publish(this.id, 'newProducer', producerInfo);
            this.notifyLocalPeers('newProducer', producerInfo, peerId);

            return { id: producer.id };
        } catch (error) {
            logger.error(`Room ${this.id}: Failed to create producer for peer ${peerId}:`, error);
            throw errors.createError(errors.MEDIASOUP_ERROR, `Producer creation failed: ${error.message}`);
        }
    }

    /** Closes a local producer, updates Redis, and notifies peers. */
    async closeProducer(peerId, producerId) {
        const peer = this.getPeer(peerId);
        if (!peer) return; // Not a local peer's producer

        const producer = peer.getProducer(producerId);
        if (!producer) return; // Producer doesn't exist or already closed

        logger.info(`Room ${this.id}: Closing producer ${producerId} for peer ${peerId}`);
        try {
            if (!producer.closed) {
                 peer.removeProducer(producerId); // Calls producer.close()
            }
            // Update Redis Hash & Publish event (even if already closed locally, ensure Redis/PubSub consistency)
            await this._redisManager.removeProducerFromRoom(this.id, producerId);
            const eventData = { roomId: this.id, peerId: peerId, producerId: producerId, instanceId: this._instanceId };
            await this._redisManager.publish(this.id, 'producerClosed', eventData);
            this.notifyLocalPeers('producerClosed', eventData, peerId);
        } catch (error) {
             logger.error(`Room ${this.id}: Error during producer ${producerId} close process:`, error);
             // Don't throw here, cleanup should continue
        }
    }

    // --- Consumer Management & Piping ---
    /** Creates a consumer for a peer, handling local vs remote producers (piping). */
    async createConsumer(peerId, targetPeerId, producerId, rtpCapabilities, transportId) {
        await this.ensureRouterReady();
        const consumingPeer = this.getPeer(peerId);
        if (!consumingPeer) throw errors.createError(errors.PEER_NOT_FOUND, `Consuming peer ${peerId} not found`);
        const recvTransport = consumingPeer.getTransport(transportId);
        if (!recvTransport || recvTransport.closed || recvTransport.appData.transportType !== 'recv') {
            throw errors.createError(errors.INVALID_STATE, `Receive transport ${transportId} invalid or closed`);
        }

        // 1. Check local first
        const localProducer = this.getPeer(targetPeerId)?.getProducer(producerId);
        if (localProducer && !localProducer.closed) {
            logger.debug(`Room ${this.id}: Consuming local producer ${producerId}`);
            return this._createConsumerInternal(consumingPeer, localProducer, rtpCapabilities, recvTransport, 'local');
        }

        // 2. Get remote producer info from Redis
        const remoteProducerInfo = await this._redisManager.getProducerInfo(this.id, producerId);
        if (!remoteProducerInfo) throw errors.createError(errors.PRODUCER_NOT_FOUND, `Producer ${producerId} not found`);
        if (remoteProducerInfo.peerId !== targetPeerId) throw errors.createError(errors.INVALID_PRODUCER_OWNER, `Producer ${producerId} owner mismatch`);

        // 3. Initiate Pipe
        logger.info(`Room ${this.id}: Request by ${peerId} to consume remote producer ${producerId} from instance ${remoteProducerInfo.instanceId}`);
        try {
            const pipeProducer = await this._initiatePipe(consumingPeer, producerId, remoteProducerInfo.instanceId);
            logger.info(`Room ${this.id}: Pipe ready, consuming local pipe producer ${pipeProducer.id} for remote producer ${producerId}`);
            return this._createConsumerInternal(consumingPeer, pipeProducer, rtpCapabilities, recvTransport, 'pipe');
        } catch (error) {
            logger.error(`Room ${this.id}: Pipe initiation or consumption failed for producer ${producerId}:`, error);
            consumingPeer.rejectPendingConsumePipe(producerId, error.message || 'Piping failed');
            throw (error.code && error.message) ? error : errors.createError(errors.PIPING_ERROR, `Failed to consume remote producer ${producerId}: ${error.message}`);
        }
    }

    /** Helper to create the mediasoup consumer object and add it to the peer. */
    async _createConsumerInternal(peer, producer, rtpCapabilities, transport, origin) {
        if (!this.isRouterReady()) throw errors.createError(errors.MEDIASOUP_ERROR, 'Router not ready');
        if (!this.router.canConsume({ producerId: producer.id, rtpCapabilities })) {
            throw errors.createError(errors.MEDIASOUP_ERROR, `Peer ${peer.id} cannot consume producer ${producer.id}`);
        }

        try {
            const consumer = await transport.consume({
                producerId: producer.id, rtpCapabilities,
                paused: producer.kind === 'video',
                appData: { peerId: peer.id, producerId: producer.id, transportId: transport.id, origin, ...(producer.appData.origin === 'pipe' ? { originalProducerId: producer.appData.originalProducerId } : {}) }
            });
            peer.addConsumer(consumer, origin);

            logger.info(`Peer ${peer.id}: Created consumer ${consumer.id} for producer ${producer.id} (origin: ${origin})`);
            return {
                id: consumer.id, producerId: consumer.producerId, kind: consumer.kind,
                rtpParameters: consumer.rtpParameters, paused: consumer.producerPaused,
                appData: consumer.appData,
            };
        } catch (error) {
             logger.error(`Room ${this.id}: Failed to create consumer for producer ${producer.id}, peer ${peer.id}:`, error);
             throw errors.createError(errors.MEDIASOUP_ERROR, `Consumer creation failed: ${error.message}`);
        }
    }

    /** Resumes a specific consumer for a peer. */
    async resumeConsumer(peerId, consumerId) {
        const peer = this.getPeer(peerId);
        if (!peer) throw errors.createError(errors.PEER_NOT_FOUND, `Peer ${peerId} not found`);
        const consumer = peer.getConsumer(consumerId);
        if (!consumer) throw errors.createError(errors.CONSUMER_NOT_FOUND, `Consumer ${consumerId} not found`);
        if (consumer.closed) throw errors.createError(errors.INVALID_STATE, `Consumer ${consumerId} is closed`);

        try {
            await consumer.resume();
            logger.debug(`Peer ${peerId}: Resumed consumer ${consumerId}`);
            return { resumed: true };
        } catch (error) {
            logger.error(`Room ${this.id}: Failed to resume consumer ${consumerId} for peer ${peerId}:`, error);
            throw errors.createError(errors.MEDIASOUP_ERROR, `Consumer resume failed: ${error.message}`);
        }
    }

    // --- Piping Handshake Logic ---

    /** Initiates pipe request FROM this instance TO the producing instance. */
    async _initiatePipe(consumingPeer, producerId, remoteInstanceId) {
         await this.ensureRouterReady();
         const pipeRequestId = `${producerId}_${this._instanceId}`; // Unique request ID

         // Create promise waiting for pipe producer ID
         const consumePipePromise = consumingPeer.addPendingConsumePipe(producerId);

         // Publish request to remote instance
         await this._redisManager.publish(this.id, 'requestPipeTransport', {
             roomId: this.id, pipeRequestId: pipeRequestId,
             requestingInstanceId: this._instanceId,
             producingInstanceId: remoteInstanceId,
             producerId: producerId,
         });

         // Wait for handshake completion (pipeProducerReady event resolves the promise)
         const { pipeProducerId } = await consumePipePromise;

         // Find the locally created pipe producer object
         const pipeProducer = this.router?.producers?.get(pipeProducerId); // Use optional chaining
         if (!pipeProducer || pipeProducer.closed) {
              throw errors.createError(errors.PIPING_ERROR, `Pipe producer ${pipeProducerId} not found or closed after ready signal`);
         }
         return pipeProducer;
    }

    /** Handles 'requestPipeTransport' event: Creates listening transport, responds with details. */
    async _handlePipeTransportRequest(pipeRequestId, requestingInstanceId, producerId) {
        logger.info(`Room ${this.id}: Handling pipe transport request ${pipeRequestId} for producer ${producerId} from instance ${requestingInstanceId}`);
        await this.ensureRouterReady();
        if (!this.isRouterReady()) {
            // Cannot proceed without router, notify requester
             logger.warn(`Room ${this.id}: Router not ready, cannot fulfill pipe request ${pipeRequestId}`);
             await this._redisManager.publish(this.id, 'pipeCreationFailed', {
                 roomId: this.id, pipeRequestId, requestingInstanceId, producerId,
                 reason: 'Producing instance router not ready'
             });
            return;
        }

        let transportInfo = null;
        let errorReason = null;
        let pipeTransport = null;

        try {
            // Find the original local producer
            const producer = Array.from(this._peers.values())
                                .flatMap(p => p.getAllProducers())
                                .find(p => p.id === producerId);
            if (!producer || producer.closed) throw new Error(`Producer ${producerId} not found/closed locally`);

            // Create the pipe transport on this (producing) instance
            pipeTransport = await this.router.createPipeTransport({
                 listenInfo: {
                     ...config.mediasoup.pipeTransportOptions.listenInfo,
                     announcedIp: config.mediasoup.webRtcTransportOptions.listenInfos[0].announcedIp
                 },
                 enableSctp : false,
                 appData: { pipeRequestId, type: 'pipe-listen', targetInstanceId: requestingInstanceId }
             });

            this._incomingPipeTransports.set(pipeTransport.id, pipeTransport); // Track incoming pipes
            pipeTransport.observer.once('close', () => {
                 logger.warn(`Room ${this.id}: Incoming pipe transport ${pipeTransport.id} from ${requestingInstanceId} closed.`);
                 this._incomingPipeTransports.delete(pipeTransport.id);
            });

            // Prepare the response payload with necessary details
            transportInfo = {
                id: pipeTransport.id, ip: pipeTransport.tuple.localIp, port: pipeTransport.tuple.localPort,
                srtpParameters: pipeTransport.srtpParameters,
                // --- Include producer details needed by the consuming side's transport.produce() ---
                kind: producer.kind,
                rtpParameters: producer.rtpParameters,
                paused: producer.paused,
                producerAppData: producer.appData
            };
            logger.info(`Room ${this.id}: Pipe transport ${pipeTransport.id} created locally, listening on ${transportInfo.ip}:${transportInfo.port}`);

        } catch (error) {
            logger.error(`Room ${this.id}: Failed creating local pipe transport for request ${pipeRequestId}:`, error);
            errorReason = error.message;
            if (pipeTransport && !pipeTransport.closed) pipeTransport.close();
        }

        // Respond via Redis
        const responseEvent = errorReason ? 'pipeCreationFailed' : 'pipeTransportReady';
        await this._redisManager.publish(this.id, responseEvent, {
             roomId: this.id, pipeRequestId, requestingInstanceId, producerId,
             transportInfo, reason: errorReason,
        });
    }

    /** Handles 'pipeTransportReady' event: Creates connecting transport, connects, creates pipe producer. */
    async _handlePipeTransportReady(pipeRequestId, producingInstanceId, producerId, remoteTransportInfo) {
        logger.info(`Room ${this.id}: Handling pipe transport ready for request ${pipeRequestId}, producer ${producerId} from instance ${producingInstanceId}`);
        await this.ensureRouterReady();
        if (!this.isRouterReady()) {
            logger.error(`Room ${this.id}: Router not ready, cannot establish pipe for ${producerId}.`);
             this._peers.forEach(peer => peer.rejectPendingConsumePipe(producerId, 'Local router became unavailable'));
            return;
        }

        // Validate required info received from the producing instance
        if (!remoteTransportInfo?.id || !remoteTransportInfo.ip || !remoteTransportInfo.port || !remoteTransportInfo.kind || !remoteTransportInfo.rtpParameters) {
             logger.error(`Room ${this.id}: Missing critical info in pipeTransportReady payload for producer ${producerId}`);
             this._peers.forEach(peer => peer.rejectPendingConsumePipe(producerId, 'Pipe setup failed: Incomplete remote info'));
             // Optionally notify the producing instance that the payload was bad?
             return; // Cannot proceed
        }

        let localPipeTransport = null;

        try {
             // Check if a pipe transport to this instance already exists and is usable
             let existingTransport = this._outgoingPipeTransports.get(producingInstanceId);
             if (existingTransport && !existingTransport.closed) {
                 localPipeTransport = existingTransport;
                 logger.debug(`Room ${this.id}: Reusing existing outgoing pipe transport ${localPipeTransport.id} to ${producingInstanceId}`);
             } else {
                // Create the connecting pipe transport on this (consuming) instance
                localPipeTransport = await this.router.createPipeTransport({
                    listenInfo: { // Provide listen details for this side
                        ...config.mediasoup.pipeTransportOptions.listenInfo,
                        announcedIp: config.mediasoup.webRtcTransportOptions.listenInfos[0].announcedIp
                    },
                    enableSctp : false,
                    appData: { pipeRequestId, type: 'pipe-connect', targetInstanceId: producingInstanceId }
                });
                this._outgoingPipeTransports.set(producingInstanceId, localPipeTransport);
                localPipeTransport.observer.once('close', () => {
                    logger.warn(`Room ${this.id}: Outgoing pipe transport ${localPipeTransport.id} to ${producingInstanceId} closed.`);
                    this._outgoingPipeTransports.delete(producingInstanceId);
                });

                // Connect this transport to the remote instance's listening transport
                await localPipeTransport.connect({
                    ip: remoteTransportInfo.ip,
                    port: remoteTransportInfo.port,
                    srtpParameters: remoteTransportInfo.srtpParameters // May be undefined if SRTP not used
                });
                logger.info(`Room ${this.id}: Local pipe transport ${localPipeTransport.id} connected to remote ${producingInstanceId}`);
             }


             // Create the local Producer that consumes from the remote producer via the pipe
             const pipeProducer = await localPipeTransport.produce({
                 producerId : producerId, // ID of the original remote producer
                 kind       : remoteTransportInfo.kind,
                 rtpParameters : remoteTransportInfo.rtpParameters,
                 paused     : remoteTransportInfo.paused,
                 appData    : {
                     ...(remoteTransportInfo.producerAppData || {}), // Include original appData
                     pipeRequestId,
                     originalProducerId: producerId,
                     producingInstanceId: producingInstanceId,
                     origin: 'pipe' // Mark this producer as originating from a pipe
                    }
             });

             // Listen for the pipe producer closing, e.g., if the underlying transport closes
             pipeProducer.observer.once('close', () => {
                 logger.warn(`Room ${this.id}: Pipe producer ${pipeProducer.id} (for original ${producerId}) closed.`);
                 // Consumers listening to this pipeProducer will get 'producerclose' event automatically
             });

             logger.info(`Room ${this.id}: Created local pipe producer ${pipeProducer.id} consuming remote producer ${producerId}`);

             // Notify the consuming peer(s) locally that the pipe producer is ready
             this._peers.forEach(peer => {
                 peer.resolvePendingConsumePipe(producerId, pipeProducer.id);
             });

        } catch (error) {
             logger.error(`Room ${this.id}: Failed handling pipeTransportReady for request ${pipeRequestId}:`, error);
             this._peers.forEach(peer => {
                 peer.rejectPendingConsumePipe(producerId, `Pipe connection/producer failed: ${error.message}`);
             });
             // Clean up the connecting transport if it was newly created and failed
             if (localPipeTransport && !this._outgoingPipeTransports.has(producingInstanceId) && !localPipeTransport.closed) {
                 localPipeTransport.close();
             }
        }
    }

    /** Handles 'pipeCreationFailed' event: Rejects pending consume requests. */
    _handlePipeCreationFailed(pipeRequestId, producingInstanceId, producerId, reason) {
         logger.error(`Room ${this.id}: Received pipe creation failed signal for producer ${producerId} from instance ${producingInstanceId}: ${reason}`);
         this._peers.forEach(peer => {
             peer.rejectPendingConsumePipe(producerId, `Remote pipe creation failed: ${reason}`);
         });
    }


    // --- Redis Event Handler ---
    async handleRedisEvent(eventType, data) {
        // No change needed here from previous 'fix all' version
        // It correctly routes to the internal _handle* methods
         logger.debug(`Room ${this.id}: Handling Redis event '${eventType}' from instance ${data.senderInstanceId}`);
        const payload = data.payload;
        const remoteInstanceId = data.senderInstanceId;

        try {
            switch (eventType) {
                case 'peerJoined': this.notifyLocalPeers('peerJoined', { peerId: payload.peerId }, null); break;
                case 'peerClosed':
                    // Reject pending consume requests for producers owned by the leaving peer
                    this._peers.forEach(p => {
                        // Check both remote producers map (if available) and local pipe producers appData
                        if (p._pendingConsumePipes.has(payload.producerId)) { // Simple check if key exists
                            p.rejectPendingConsumePipe(payload.producerId, `Producer owner ${payload.peerId} left`);
                        }
                        // More robust check might involve iterating _pendingConsumePipes and checking producerInfo from Redis
                    });
                    this.notifyLocalPeers('peerClosed', { peerId: payload.peerId }, null); break;
                case 'newProducer': this.notifyLocalPeers('newProducer', payload, null); break;
                case 'producerClosed':
                    this._peers.forEach(p => p.rejectPendingConsumePipe(payload.producerId, 'Producer closed remotely'));
                    this.notifyLocalPeers('producerClosed', payload, null); break;

                // Piping Events
                case 'requestPipeTransport':
                    if (payload.producingInstanceId === this._instanceId) await this._handlePipeTransportRequest(payload.pipeRequestId, payload.requestingInstanceId, payload.producerId);
                    break;
                case 'pipeTransportReady':
                    if (payload.requestingInstanceId === this._instanceId) await this._handlePipeTransportReady(payload.pipeRequestId, remoteInstanceId, payload.producerId, payload.transportInfo);
                    break;
                 case 'pipeCreationFailed':
                     if (payload.requestingInstanceId === this._instanceId) this._handlePipeCreationFailed(payload.pipeRequestId, remoteInstanceId, payload.producerId, payload.reason);
                     break;
            }
        } catch (error) {
             logger.error(`Room ${this.id}: Error handling Redis event ${eventType} from ${remoteInstanceId}:`, error);
        }
    }


    // --- Utilities ---
    /** Notifies locally connected peers, excluding one if specified. */
    notifyLocalPeers(method, params, excludePeerId = null) {
        this._peers.forEach(peer => {
            if (peer.id !== excludePeerId) {
                peer.notify(method, params);
            }
        });
    }

    /** Gets the router's RTP capabilities. */
    getRouterRtpCapabilities() {
        if (!this.isRouterReady()) throw errors.createError(errors.MEDIASOUP_ERROR, 'Router not initialized yet');
        return this.router.rtpCapabilities;
    }

    /** Gets basic information about the room state on this instance. */
    getRoomInfo() {
        const localPeersInfo = Array.from(this._peers.keys());
        const localProducersInfo = Array.from(this._peers.values()).flatMap(p => p.getAllProducers()).map(prod => ({
             id: prod.id, peerId: prod.appData.peerId, kind: prod.kind, appData: prod.appData
        }));
        return {
            roomId: this.id, instanceId: this._instanceId, routerId: this.router?.id,
            localPeers: localPeersInfo, localProducers: localProducersInfo,
            outgoingPipes: Array.from(this._outgoingPipeTransports.keys()),
            incomingPipes: Array.from(this._incomingPipeTransports.keys()),
        };
    }

    // --- Close Methods ---
    /** Closes all active pipe transports associated with this room instance. */
    _closeAllPipeTransports() {
         logger.warn(`Room ${this.id}: Closing all pipe transports.`);
         this._outgoingPipeTransports.forEach(t => { if (!t.closed) t.close(); });
         this._outgoingPipeTransports.clear();
         this._incomingPipeTransports.forEach(t => { if (!t.closed) t.close(); });
         this._incomingPipeTransports.clear();
    }

    /** Closes the room, including router, peers, and pipe transports. */
    close() {
        logger.warn(`Closing room ${this.id} resources on instance ${this._instanceId}.`);
        this._closeAllPipeTransports(); // Close pipes first

        // Close local peers gracefully
        this._peers.forEach(peer => {
            if(this._peers.has(peer.id)) { // Check if still present
                peer.close(`Room ${this.id} closing`);
            }
        });
        this._peers.clear(); // Clear local map

        // Close the router
        if (this.isRouterReady()) {
            this.router.close();
        }
        logger.info(`Room ${this.id}: Closed locally.`);
        // Note: Redis key cleanup (instance count, sets) happens in server.js handleLeaveRoom/shutdown
    }
}

module.exports = Room;
```

---
**8. `server.js`**
```javascript
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
```

---
**9. `Dockerfile`**
```dockerfile
# Use an official Node.js runtime as a parent image
FROM node:18

# Install dependencies needed for building mediasoup-worker
# build-essential provides make, g++, etc.
# python3-pip provides pip
# python3 is usually included, but explicit doesn't hurt
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (or yarn.lock)
# Copying these first leverages Docker cache if only code changes later
COPY package*.json ./

# Install app dependencies including devDependencies if build scripts need them
# Mediasoup build might happen here during postinstall scripts
RUN npm install
# If devDependencies were only needed for build, prune them:
RUN npm prune --omit=dev

# Bundle app source (including the 'public' directory)
COPY . .

# Generate certs if they don't exist (optional, better to mount them)
# RUN if [ ! -f "certs/cert.pem" ]; then npm run generate-certs; fi

# Your app binds to port 3000 (or whatever $PORT is)
EXPOSE ${PORT:-3000}

# Mediasoup RTC ports (UDP/TCP) - Mapped in docker-compose
# EXPOSE 10000-10999/udp
# EXPOSE 10000-10999/tcp

# Define the command to run your app
CMD [ "npm", "start" ]
```

---
**10. `docker-compose.yml`**
```yaml
version: '3.8'

services:
  # Redis Service
  redis:
    image: redis:7-alpine
    container_name: mediasoup_redis
    command: redis-server --save "" --appendonly no # Disable persistence for testing
    ports:
      - "127.0.0.1:6379:6379" # Expose Redis only on localhost for security
    volumes:
      - redis_data:/data
    restart: unless-stopped
    networks:
      - mediasoup-net
    healthcheck: # Added healthcheck for Redis
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Mediasoup Application Service
  app:
    build: .
    container_name: mediasoup_app
    depends_on:
      redis: # Ensure Redis is healthy before starting app
        condition: service_healthy
    volumes:
      # Mount certificates (read-only) - Generate these on the host first!
      - ./certs:/usr/src/app/certs:ro
      # Mount the environment file (read-only)
      - ./.env:/usr/src/app/.env:ro
    ports:
      # Map the HTTPS/WSS port
      - "${PORT:-3000}:${PORT:-3000}"
      # Map the Mediasoup UDP RTP port range (CRITICAL) - Uses .env values
      - "${MEDIASOUP_RTC_MIN_PORT:-10000}-${MEDIASOUP_RTC_MAX_PORT:-10999}:${MEDIASOUP_RTC_MIN_PORT:-10000}-${MEDIASOUP_RTC_MAX_PORT:-10999}/udp"
      # Map the Mediasoup TCP RTP port range (If TCP fallback needed/enabled)
      # - "${MEDIASOUP_RTC_MIN_PORT:-10000}-${MEDIASOUP_RTC_MAX_PORT:-10999}:${MEDIASOUP_RTC_MIN_PORT:-10000}-${MEDIASOUP_RTC_MAX_PORT:-10999}/tcp"
    environment:
      # Ensure NODE_ENV is set (can also be in .env)
      - NODE_ENV=${NODE_ENV:-production}
      # Let app connect to Redis via service name
      - REDIS_HOST=redis
      # MEDIASOUP_ANNOUNCED_IP is read from the mounted .env file
    restart: unless-stopped
    networks:
      - mediasoup-net
    # Optional: Increase file descriptor limits
    # ulimits:
    #   nofile:
    #     soft: 65536
    #     hard: 65536

# Define the network
networks:
  mediasoup-net:
    driver: bridge

# Define named volume for Redis persistence
volumes:
  redis_data:
```

---
**11. `public/index.html`**
```html
<!DOCTYPE html>
<html>
<head>
    <title>Mediasoup Test Client</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="style.css">
    <!-- Load mediasoup-client library -->
    <script src="https://cdn.jsdelivr.net/npm/mediasoup-client@3/dist/mediasoup-client.min.js"></script>
</head>
<body>
    <h1>Mediasoup Test Client</h1>

    <div class="controls">
        <label for="serverUrl">Server WSS URL:</label>
        <input type="text" id="serverUrl" value=""> <!-- Value set by JS -->

        <label for="roomId">Room ID:</label>
        <input type="text" id="roomId" value="test-room-1">

        <label for="peerId">Peer ID:</label>
        <input type="text" id="peerId" value="peer-<%= Math.random().toString(36).substring(2, 8) %>"> <!-- Generate random default -->

        <button id="btnJoin">Join Room</button>
        <button id="btnLeave" disabled>Leave Room</button>
        <button id="btnPublish" disabled>Publish Cam/Mic</button>
        <button id="btnStopPublish" disabled>Stop Publishing</button>
        <!-- Add Screen Share Button later if desired -->
        <span id="connectionStatus" class="status-disconnected">Disconnected</span>
    </div>

    <div class="media-container">
        <div class="video-wrapper">
            <h2>Local Video</h2>
            <video id="localVideo" autoplay muted playsinline></video>
        </div>
        <div id="remoteVideos" class="remote-videos-wrapper">
            <h2>Remote Videos</h2>
            <!-- Remote videos will be added here -->
        </div>
    </div>

    <div class="logs">
        <h2>Logs</h2>
        <pre id="logOutput"></pre>
    </div>

    <script src="client.js"></script>
</body>
</html>
```

---
**12. `public/style.css`**
```css
body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
    padding: 1em;
    line-height: 1.5;
    background-color: #f4f7f6;
    color: #333;
}

h1, h2 {
    color: #005f73;
    border-bottom: 2px solid #94d2bd;
    padding-bottom: 0.3em;
    margin-bottom: 0.7em;
}

.controls {
    margin-bottom: 1.5em;
    padding: 1em;
    border: 1px solid #ccc;
    border-radius: 8px;
    background-color: #fff;
    display: flex;
    gap: 15px;
    align-items: center;
    flex-wrap: wrap;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.controls label {
    margin-right: 0.5em;
    font-weight: bold;
    color: #0a9396;
}

.controls input[type="text"] {
    padding: 8px 10px;
    margin-right: 1em;
    border: 1px solid #ccc;
    border-radius: 4px;
    min-width: 150px;
}

.controls button {
    padding: 10px 18px;
    cursor: pointer;
    border: none;
    border-radius: 4px;
    background-color: #0a9396;
    color: white;
    font-weight: bold;
    transition: background-color 0.2s ease;
}

.controls button:hover:not(:disabled) {
    background-color: #005f73;
}

.controls button:disabled {
    background-color: #a0aec0;
    cursor: not-allowed;
}

.status-connected {
    color: #2f855a;
    font-weight: bold;
    margin-left: auto; /* Push status to the right */
    padding: 5px 10px;
    background-color: #c6f6d5;
    border-radius: 4px;
}

.status-disconnected {
    color: #c53030;
    font-weight: bold;
    margin-left: auto;
    padding: 5px 10px;
    background-color: #fed7d7;
    border-radius: 4px;
}


.media-container {
    display: flex;
    gap: 20px;
    flex-wrap: wrap;
    margin-bottom: 1.5em;
}

.video-wrapper, .remote-videos-wrapper {
    border: 1px solid #e2e8f0;
    padding: 1em;
    border-radius: 8px;
    background-color: #fff;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    flex: 1; /* Allow flexible growth */
    min-width: 340px; /* Minimum width before wrapping */
}

video, audio {
    width: 100%; /* Take full width of container */
    height: auto;
    background-color: black;
    border-radius: 5px;
    display: block; /* Remove extra space below video */
}
audio {
    max-width: 320px; /* Limit audio player width */
}

.remote-video-container {
    margin-bottom: 1.5em;
    padding-bottom: 1em;
    border-bottom: 1px dashed #ccc;
}
.remote-video-container:last-child {
    border-bottom: none;
    margin-bottom: 0;
    padding-bottom: 0;
}
.remote-video-container h3 {
    margin-top: 0;
    font-size: 1em;
    color: #555;
}

.logs {
    margin-top: 2em;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    background-color: #2d3748; /* Dark background */
    color: #e2e8f0; /* Light text */
    padding: 1em;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}
.logs h2 {
    color: #94d2bd;
    border-bottom-color: #4a5568;
    margin-top: 0;
}
#logOutput {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
    font-size: 0.85em;
    max-height: 300px;
    overflow-y: auto;
    white-space: pre-wrap; /* Wrap long lines */
    word-break: break-all;
    margin: 0;
    padding: 0;
}

/* Basic responsiveness */
@media (max-width: 768px) {
    .controls {
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
    }
    .controls label {
        margin-right: 0;
        margin-bottom: 5px;
        display: block; /* Labels on own line */
    }
    .controls input[type="text"] {
        margin-right: 0;
        width: calc(100% - 22px); /* Adjust for padding/border */
    }
     .controls button {
        width: 100%;
     }
    .status-connected, .status-disconnected {
        margin-left: 0; /* Remove auto margin */
        text-align: center;
        margin-top: 10px;
    }
     .media-container {
        flex-direction: column;
     }
}
```

---
**13. `public/client.js`**
```javascript
// client.js
/* eslint-disable no-unused-vars, no-inner-declarations */

const mediasoupClient = window.mediasoupClient; // Access from CDN global scope

// --- DOM Elements ---
const serverUrlInput = document.getElementById('serverUrl');
const roomIdInput = document.getElementById('roomId');
const peerIdInput = document.getElementById('peerId');
const btnJoin = document.getElementById('btnJoin');
const btnLeave = document.getElementById('btnLeave');
const btnPublish = document.getElementById('btnPublish');
const btnStopPublish = document.getElementById('btnStopPublish');
const localVideo = document.getElementById('localVideo');
const remoteVideosContainer = document.getElementById('remoteVideos');
const logOutput = document.getElementById('logOutput');
const connectionStatus = document.getElementById('connectionStatus');

// --- Client State ---
let ws = null;
let device;
let sendTransport;
let recvTransport;
let localStream; // Local camera/mic stream
let producers = new Map(); // Map<kind ('audio'|'video'), Producer>
let consumers = new Map(); // Map<consumerId, Consumer>
let remoteProducers = new Map(); // Map<producerId, ProducerInfo> from server
let nextRequestId = 1;
const pendingRequests = new Map(); // Map<requestId, {resolve, reject, timeoutId}>
let isConnected = false;

// --- Logging ---
function log(...args) {
    console.log(...args);
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg).join(' ');
    logOutput.textContent += `[${new Date().toLocaleTimeString()}] ${message}\n`;
    logOutput.scrollTop = logOutput.scrollHeight; // Auto-scroll
}
function logError(...args) {
    console.error(...args);
    const message = args.map(arg => (arg instanceof Error) ? arg.message : (typeof arg === 'object' ? JSON.stringify(arg) : arg)).join(' ');
    logOutput.textContent += `[${new Date().toLocaleTimeString()}] [ERROR] ${message}\n`;
    logOutput.scrollTop = logOutput.scrollHeight;
}

// --- Set Default Server URL ---
serverUrlInput.value = `wss://${window.location.host}`;
// --- Set Random Default Peer ID ---
peerIdInput.value = `peer_${Math.random().toString(36).substring(2, 8)}`;


// --- WebSocket and JSON-RPC ---

/** Establishes WebSocket connection. */
function connectWebSocket() {
    const serverUrl = serverUrlInput.value.trim();
    if (!serverUrl) {
        logError('Please enter a server URL');
        return;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        log('WebSocket already connecting or open.');
        return;
    }

    log(`Connecting to WebSocket server at ${serverUrl}...`);
    updateConnectionStatus('Connecting...');

    ws = new WebSocket(serverUrl);

    ws.onopen = () => {
        log('WebSocket connection established');
        isConnected = true;
        btnJoin.disabled = false; // Enable join button
        updateConnectionStatus('Connected');
    };

    ws.onmessage = (event) => handleWebSocketMessage(event.data);

    ws.onerror = (error) => {
        logError('WebSocket error:', error);
        alert(`WebSocket error. Check console and server URL.\nURL: ${serverUrl}\nIs the server running? Is the certificate trusted?`);
        resetClientState(); // Reset UI on error
    };

    ws.onclose = (event) => {
        log(`WebSocket connection closed: Code ${event.code}, Reason: ${event.reason}`);
        if (isConnected) { // Only show alert if we were previously connected
            alert('WebSocket connection closed.');
        }
        resetClientState();
    };
}

/** Sends a JSON-RPC request and returns a Promise. */
function sendRpcRequest(method, params) {
    return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return reject(errors.createError(errors.INVALID_STATE, 'WebSocket is not connected'));
        }
        const requestId = nextRequestId++;
        const request = { jsonrpc: '2.0', id: requestId, method, params: params || {} };
        log('Sending RPC Request:', request);
        ws.send(JSON.stringify(request));

        // Timeout for request
        const timeoutId = setTimeout(() => {
            if (pendingRequests.has(requestId)) {
                 logError(`Request ${requestId} (${method}) timed out`);
                 pendingRequests.get(requestId).reject(errors.createError(errors.INTERNAL_ERROR, `Request timed out`));
                 pendingRequests.delete(requestId);
            }
        }, 15000); // 15 second timeout

        pendingRequests.set(requestId, { resolve, reject, timeoutId });
    });
}

/** Handles incoming WebSocket messages (Responses & Notifications). */
function handleWebSocketMessage(data) {
    try {
        const message = JSON.parse(data);
        log('Received message:', message);

        if (message.id && pendingRequests.has(message.id)) {
            // Handle RPC Response
            const pending = pendingRequests.get(message.id);
            clearTimeout(pending.timeoutId); // Clear timeout on response
            if (message.error) {
                logError('RPC Error Response:', message.error);
                pending.reject(message.error); // Reject promise with structured error
            } else {
                pending.resolve(message.result); // Resolve promise with result
            }
            pendingRequests.delete(message.id);
        } else if (message.method) {
            // Handle RPC Notification
            handleRpcNotification(message.method, message.params);
        } else {
            log('Received unexpected message:', message);
        }
    } catch (error) {
        logError('Failed to parse WebSocket message:', error, data);
    }
}

/** Routes incoming notifications to specific handlers. */
function handleRpcNotification(method, params) {
    log(`Received notification: ${method}`);
    try {
        switch (method) {
            case 'newProducer': handleNewProducer(params); break;
            case 'producerClosed': handleProducerClosed(params); break;
            case 'peerJoined': log(`Peer ${params.peerId} joined`); /* Update UI? */ break;
            case 'peerClosed': log(`Peer ${params.peerId} left`); /* UI update? */ break;
            case 'consumerClosed': handleConsumerClosed(params.consumerId, params.reason); break;
            case 'consumerPaused': handleConsumerPaused(params.consumerId); break;
            case 'consumerResumed': handleConsumerResumed(params.consumerId); break;
            case 'serverShutdown': handleServerShutdown(params.reason); break;
            // Handle other notifications like consumerLayersChanged etc.
            default: log(`Unhandled notification method: ${method}`);
        }
    } catch(error){
        logError(`Error handling notification ${method}:`, error);
    }
}

// --- Mediasoup Logic ---

/** Joins the room after WebSocket connection. */
async function joinRoom() {
    const roomId = roomIdInput.value.trim();
    const peerId = peerIdInput.value.trim();
    if (!roomId || !peerId) {
        alert('Please enter Room ID and Peer ID');
        return;
    }
    if (!device) { // Initialize device only once
        device = new mediasoupClient.Device();
    }
     if (device.loaded) {
        log('Device already loaded.');
     }

    btnJoin.disabled = true;
    log(`Joining room ${roomId} as peer ${peerId}...`);
    updateConnectionStatus('Joining...');

    try {
        // Note: Getting capabilities separately might be better if join fails often
        // const routerRtpCapabilities = await sendRpcRequest('getRouterRtpCapabilities', { roomId });
        // await device.load({ routerRtpCapabilities });

        const { routerRtpCapabilities, peers: initialPeers, producers: initialProducers } = await sendRpcRequest('joinRoom', { roomId, peerId });
        log('Joined room successfully!');

        // Load device if not already loaded
         if (!device.loaded) {
            await device.load({ routerRtpCapabilities });
            log('Mediasoup device loaded');
         } else {
            log('Mediasoup device already loaded, proceeding.');
         }

        // Create Transports (check if they exist before creating)
        if (!sendTransport || sendTransport.closed) await createSendTransport();
        if (!recvTransport || recvTransport.closed) await createRecvTransport();

        // Update UI
        btnLeave.disabled = false;
        btnPublish.disabled = false; // Enable publish after transports are ready
        roomIdInput.disabled = true;
        peerIdInput.disabled = true;
        serverUrlInput.disabled = true;
        updateConnectionStatus('Joined');


        // Subscribe to initial producers
        log(`Initial producers: ${initialProducers.length}`);
        initialProducers.forEach(producerInfo => {
             log(`Processing initial producer: ${producerInfo.producerId} from peer ${producerInfo.peerId}`);
             remoteProducers.set(producerInfo.id, producerInfo); // Store producer info using producer ID as key
             subscribeToProducer(producerInfo.id); // Attempt subscription
         });

        log(`Initial peers in room: ${initialPeers.join(', ')}`);

    } catch (error) {
        logError('Failed to join room:', error);
        const errorMsg = error.message || (typeof error === 'string' ? error : `Code: ${error.code}`);
        alert(`Failed to join room: ${errorMsg}`);
        resetClientState(); // Reset state on failure
        // Keep WebSocket open for retry unless join specifically failed due to WS issue
        // if (ws) ws.close(); // Optional: Close WS on join failure
    } finally {
         // Re-enable join button only if we are not actually joined
         if (!device?.loaded || !sendTransport || !recvTransport) {
             btnJoin.disabled = !isConnected; // Enable if WS is connected
         }
    }
}

/** Creates the Mediasoup Send Transport. */
async function createSendTransport() {
    log('Creating send transport...');
    const transportInfo = await sendRpcRequest('createWebRtcTransport', { direction: 'send' });
    if (!transportInfo || !device) {
         logError("Cannot create send transport: Missing transport info or device");
         return;
    }

    sendTransport = device.createSendTransport(transportInfo);
    log('Send transport created:', sendTransport.id);

    // --- Event Listeners ---
    sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        log('Send transport "connect" event');
        try {
            await sendRpcRequest('connectWebRtcTransport', { transportId: sendTransport.id, dtlsParameters });
            callback();
            log('Send transport connected to server');
        } catch (error) { logError('Send transport connection failed:', error); errback(error); }
    });

    sendTransport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
        log(`Send transport "produce" event for kind ${kind}`);
        try {
            const { id: producerId } = await sendRpcRequest('produce', {
                transportId: sendTransport.id, kind, rtpParameters, appData
            });
            log(`Server created producer ${producerId} for kind ${kind}`);
            callback({ id: producerId }); // Provide server-side producer ID
        } catch (error) { logError(`Server-side produce failed for kind ${kind}:`, error); errback(error); }
    });

    sendTransport.on('connectionstatechange', (state) => {
        log(`Send transport connection state: ${state}`);
        if (state === 'failed' || state === 'closed' || state === 'disconnected') {
            logError(`Send transport state changed to ${state}, might need to clean up producers.`);
            // Force stop publishing if transport fails
            if (producers.size > 0) {
                 stopPublishing('Transport disconnected');
            }
        }
    });
}

/** Creates the Mediasoup Receive Transport. */
async function createRecvTransport() {
    log('Creating recv transport...');
    const transportInfo = await sendRpcRequest('createWebRtcTransport', { direction: 'recv' });
     if (!transportInfo || !device) {
         logError("Cannot create recv transport: Missing transport info or device");
         return;
    }

    recvTransport = device.createRecvTransport(transportInfo);
    log('Recv transport created:', recvTransport.id);

    // --- Event Listeners ---
    recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        log('Recv transport "connect" event');
        sendRpcRequest('connectWebRtcTransport', { transportId: recvTransport.id, dtlsParameters })
            .then(() => {
                callback();
                log('Recv transport connected to server');
                // Attempt to consume any known producers now that transport is ready
                remoteProducers.forEach(producerInfo => subscribeToProducer(producerInfo.id));
            })
            .catch(error => { logError('Recv transport connection failed:', error); errback(error); });
    });

    recvTransport.on('connectionstatechange', (state) => {
        log(`Recv transport connection state: ${state}`);
        if (state === 'failed' || state === 'closed' || state === 'disconnected') {
            logError(`Receive transport state changed to ${state}, consumers may be closed.`);
            // Consumers should close automatically when transport closes.
        }
    });
}

/** Gets and publishes local camera and microphone tracks. */
async function publishLocalMedia() {
    if (!sendTransport || !device) {
        alert('Cannot publish: Send transport or device not ready.'); return;
    }
    if (!sendTransport || sendTransport.connectionState !== 'connected') {
        alert('Cannot publish: Send transport not connected.'); return;
    }
    if (producers.has('video') || producers.has('audio')) {
        log('Already publishing.'); return;
    }

    log('Requesting local media (cam/mic)...');
    btnPublish.disabled = true; // Disable button during process

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: { width: { ideal: 640 }, height: { ideal: 360 } }
        });
        log('Got local media stream');
        localVideo.srcObject = localStream;

        const audioTrack = localStream.getAudioTracks()[0];
        const videoTrack = localStream.getVideoTracks()[0];

        // Error handling within try block
        const createAndTrackProducer = async (kind, track, options = {}, appData = {}) => {
            if (!track) return;
             try {
                log(`Publishing ${kind}...`);
                const producer = await sendTransport.produce({ track, ...options, appData: { ...appData, mediaType: kind } });
                producers.set(kind, producer);
                log(`${kind} producer created: ${producer.id}`);

                producer.on('transportclose', () => {
                    log(`${kind} producer transport closed`);
                    producers.delete(kind);
                    updatePublishButtonState();
                });
                producer.on('trackended', () => {
                    log(`${kind} track ended`);
                    stopPublishing(`${kind} track ended`);
                });
            } catch (trackError) {
                 logError(`Failed to publish ${kind}:`, trackError);
                 throw trackError; // Re-throw to be caught by outer catch
            }
        };

        await createAndTrackProducer('audio', audioTrack, { codecOptions: { opusStereo: true, opusDtx: true } });
        await createAndTrackProducer('video', videoTrack, {
             encodings: [
                { maxBitrate: 100000, scaleResolutionDownBy: 4 },
                { maxBitrate: 300000, scaleResolutionDownBy: 2 },
                { maxBitrate: 1000000, scaleResolutionDownBy: 1 }
             ],
             codecOptions: { videoGoogleStartBitrate: 1000 }
         });

        updatePublishButtonState(); // Update button states after successful publishing

    } catch (error) {
        logError('Failed to get or publish media:', error);
        alert(`Error publishing media: ${error.message}`);
        if (localStream) { // Clean up stream
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
            localVideo.srcObject = null;
        }
        // Clean up any producers that might have been created before failure
        producers.forEach(p => { if (!p.closed) p.close(); });
        producers.clear();
        updatePublishButtonState(); // Ensure buttons are correct after failure
    }
}

/** Stops publishing local media tracks. */
async function stopPublishing(reason = 'User action') {
    log(`Stopping publishing... Reason: ${reason}`);
    let stopped = false;

    // Use Promise.allSettled to close producers concurrently
    const closePromises = [];
    producers.forEach((producer, kind) => {
        if (!producer.closed) {
            log(`Closing ${kind} producer ${producer.id}`);
            closePromises.push(
                // Optional: Notify server explicitly before closing producer if needed
                // sendRpcRequest('producerClose', { producerId: producer.id })
                //  .catch(e => logError(`Error sending producerClose for ${producer.id}:`, e))
                 // .finally(() => {
                       producer.close(); // Close mediasoup-client producer
                       stopped = true;
                 // })
            );
        }
    });

    await Promise.allSettled(closePromises);
    producers.clear(); // Clear the map after attempting to close all

    // Stop local media tracks
    if (localStream) {
        log('Stopping local stream tracks');
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
        localVideo.srcObject = null;
    }

    if (stopped) log('Publishing stopped.');
    updatePublishButtonState();
}

/** Handles notification that a new producer is available. */
function handleNewProducer(producerInfo) {
    log('Handling new producer notification:', producerInfo);
    if (!producerInfo || !producerInfo.producerId) {
        logError("Invalid newProducer notification received:", producerInfo);
        return;
    }
    // Store producer info using producerId as the key
    remoteProducers.set(producerInfo.producerId, producerInfo);

    // Attempt to subscribe if recvTransport is ready
    if (recvTransport && recvTransport.connectionState === 'connected') {
        subscribeToProducer(producerInfo.producerId);
    } else {
         log('Receive transport not ready, subscription deferred.');
    }
}

/** Initiates consumption of a remote producer. */
async function subscribeToProducer(producerId) {
    if (!recvTransport || !device || !device.loaded || !remoteProducers.has(producerId)) {
        log(`Cannot subscribe: Prerequisite missing for producer ${producerId}. Device loaded: ${device?.loaded}, Transport state: ${recvTransport?.connectionState}`);
        return;
    }
    if (consumers.has(producerId)) { // Check if already consuming THIS producerId
        log(`Already consuming producer ${producerId}`);
        return;
    }

    const producerInfo = remoteProducers.get(producerId);
    log(`Subscribing to producer ${producerId} from peer ${producerInfo.peerId}...`);

    try {
        const { rtpCapabilities } = device;
        // Request consumption from server
        const consumeData = await sendRpcRequest('consume', {
            producerId: producerId,
            transportId: recvTransport.id,
            rtpCapabilities,
            producerPeerId: producerInfo.peerId // Server needs this context
        });

        if (!consumeData || !consumeData.id) {
             throw new Error('Server did not return valid consumer parameters');
        }
        const { id: consumerId, kind, rtpParameters, appData } = consumeData;
        log(`Server created consumer ${consumerId} for producer ${producerId}`);

        // Create mediasoup-client Consumer
        const consumer = await recvTransport.consume({
            id: consumerId, producerId, kind, rtpParameters,
            appData: { ...appData, peerId: producerInfo.peerId } // Store relevant context
        });

        // Store consumer keyed by its ID for easier lookup from notifications
        consumers.set(consumerId, consumer);
        log(`Mediasoup consumer created: ${consumer.id}, track: ${consumer.track.id}, kind: ${kind}`);

        // --- Event Listeners for Consumer ---
        consumer.observer.once('close', () => {
             log(`Consumer ${consumer.id} observer closed.`);
             consumers.delete(consumerId); // Remove from our map
             removeMediaElement(consumerId); // Clean up UI
        });
        consumer.on('transportclose', () => {
            log(`Consumer ${consumer.id} transport closed`);
            // No need to call removeMediaElement here, observer close handles it
        });
        // Note: 'producerclose' notification from server handles logic now

        // Render the track
        renderRemoteTrack(producerInfo.peerId, consumerId, consumer.track); // Use consumerId for element ID

        // Resume consumer on the server AFTER rendering locally
        await sendRpcRequest('consumerResume', { consumerId: consumer.id });
        log(`Resumed consumer ${consumer.id} on server`);

    } catch (error) {
        logError(`Failed to subscribe to producer ${producerId}:`, error);
        alert(`Error subscribing to producer ${producerId}: ${error.message || 'Unknown error'}`);
        consumers.delete(producerId); // Clean up map if entry was added incorrectly
        removeMediaElement(producerId); // Clean up UI just in case
    }
}

/** Renders a remote media track in the UI. */
function renderRemoteTrack(peerId, consumerId, track) {
    // Create a container div for this peer if it doesn't exist
    const peerContainerId = `peer-container-${peerId}`;
    let peerContainer = document.getElementById(peerContainerId);
    if (!peerContainer) {
        peerContainer = document.createElement('div');
        peerContainer.id = peerContainerId;
        peerContainer.className = 'remote-video-container'; // Use existing class
        peerContainer.innerHTML = `<h3>Peer ${peerId}</h3>`;
        remoteVideosContainer.appendChild(peerContainer);
    }

    // Create media element (video or audio)
    const elementId = `remote-${consumerId}`; // Use consumerId for unique element ID
    let mediaElement = document.getElementById(elementId);

    if (mediaElement) {
        log(`Replacing existing media element for consumer ${consumerId}`);
        mediaElement.parentNode.removeChild(mediaElement);
    }

    log(`Rendering remote ${track.kind} track for consumer ${consumerId} from peer ${peerId}`);
    if (track.kind === 'video') {
        mediaElement = document.createElement('video');
        mediaElement.id = elementId;
        mediaElement.autoplay = true;
        mediaElement.playsInline = true;
        mediaElement.setAttribute('data-consumer-id', consumerId); // Add data attribute
        peerContainer.appendChild(mediaElement);
    } else {
        mediaElement = document.createElement('audio');
        mediaElement.id = elementId;
        mediaElement.autoplay = true;
        mediaElement.setAttribute('data-consumer-id', consumerId);
        peerContainer.appendChild(mediaElement); // Append audio element
    }
    mediaElement.srcObject = new MediaStream([track]);

    // If it's video, play it explicitly after adding to DOM (some browsers need this)
    if (track.kind === 'video') {
         mediaElement.play().catch(e => logError(`Video play failed for ${consumerId}:`, e));
    }
}

/** Handles notification that a remote producer was closed. */
function handleProducerClosed(params) {
    const { producerId } = params;
    log(`Handling producer closed event for producer ${producerId}`);
    remoteProducers.delete(producerId); // Remove from known producers

    // Find and close the corresponding consumer(s)
    let consumerToClose = null;
    consumers.forEach((consumer) => {
        if (consumer.producerId === producerId) {
             consumerToClose = consumer;
        }
    });

    if (consumerToClose) {
        log(`Closing consumer ${consumerToClose.id} because producer ${producerId} closed.`);
        removeConsumer(consumerToClose.id); // Use removeConsumer to handle closing and UI cleanup
    } else {
         log(`No active consumer found for closed producer ${producerId}.`);
    }
}

/** Handles notification that one of our consumers was closed by the server. */
function handleConsumerClosed(consumerId, reason) {
     log(`Server indicated consumer ${consumerId} closed. Reason: ${reason || 'N/A'}`);
     removeConsumer(consumerId); // Use central cleanup function
}

/** Handles notification that a consumer was paused by the server. */
function handleConsumerPaused(consumerId){
    log(`Consumer ${consumerId} paused by server.`);
    const consumer = consumers.get(consumerId);
    if (consumer) {
        // consumer.pause(); // Client-side consumer doesn't need explicit pause typically
        log(`Updating UI for paused consumer ${consumerId}`);
        const mediaElement = document.getElementById(`remote-${consumerId}`);
        mediaElement?.classList.add('paused'); // Add CSS class for visual indication (optional)
        // Example CSS: video.paused { opacity: 0.5; }
    }
}

/** Handles notification that a consumer was resumed by the server. */
function handleConsumerResumed(consumerId){
     log(`Consumer ${consumerId} resumed by server.`);
     const consumer = consumers.get(consumerId);
     if (consumer) {
        // consumer.resume(); // Client-side consumer doesn't need explicit resume
        log(`Updating UI for resumed consumer ${consumerId}`);
        const mediaElement = document.getElementById(`remote-${consumerId}`);
        mediaElement?.classList.remove('paused');
     }
}

/** Handles server shutdown notification */
function handleServerShutdown(reason = 'Server initiated shutdown'){
    logError(`Server shutdown notification received: ${reason}`);
    alert(`Server is shutting down: ${reason}\nConnection will be closed.`);
    // No need to call leaveRoom or close WS here, server will disconnect us.
    // resetClientState will be called by the ws.onclose handler.
}


/** Removes a consumer and its associated UI element. */
function removeConsumer(consumerId) {
    const consumer = consumers.get(consumerId);
    if (!consumer) return; // Already removed

    log(`Removing consumer ${consumer.id} (for producer ${consumer.producerId})`);
    if (!consumer.closed) {
        consumer.close(); // Close mediasoup-client consumer
    }
    consumers.delete(consumerId); // Remove from map
    removeMediaElement(consumerId); // Clean up UI
}

/** Removes the video/audio element associated with a consumer ID. */
function removeMediaElement(consumerId) {
    const mediaElement = document.getElementById(`remote-${consumerId}`);
    if (mediaElement) {
        mediaElement.srcObject = null; // Release stream tracks
        const peerContainer = mediaElement.closest('.remote-video-container'); // Find parent container
        mediaElement.parentNode.removeChild(mediaElement);
        log(`Removed remote media element for consumer ${consumerId}`);

        // Remove the peer container if it's now empty
        if (peerContainer && peerContainer.querySelectorAll('video, audio').length === 0) {
             log(`Removing empty peer container: ${peerContainer.id}`);
             peerContainer.parentNode.removeChild(peerContainer);
        }
    } else {
        log(`UI element for consumer ${consumerId} not found for removal.`);
    }
}


/** Leaves the room and cleans up resources. */
function leaveRoom() {
    log('Leaving room...');
    btnLeave.disabled = true; // Disable button during leave process

    // 1. Stop publishing first
    stopPublishing('Leaving room');

    // 2. Close transports (this should close consumers)
    if (sendTransport && !sendTransport.closed) sendTransport.close();
    if (recvTransport && !recvTransport.closed) recvTransport.close();

    // 3. Send leave request (optional, server might detect via WS close)
    if (ws && ws.readyState === WebSocket.OPEN) {
         sendRpcRequest('leaveRoom', {}).catch(e => logError("Error sending leaveRoom request:", e));
         // Don't close WS immediately, let server handle cleanup / potential response
    }

    // 4. Reset state (UI will be fully reset by WS close handler eventually)
    // Minimal reset here, full reset on WS close
    consumers.clear();
    remoteProducers.clear();
    remoteVideosContainer.innerHTML = '<h2>Remote Videos</h2>'; // Clear remote videos UI
    updatePublishButtonState();
    log('Leave room initiated.');
    // WebSocket close handler will call resetClientState for final cleanup
}

/** Resets the entire client state and UI. */
function resetClientState() {
    log('Resetting client state...');
    isConnected = false;

    // Close WebSocket if open
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'Client resetting state');
    }
    ws = null;

    // Close Mediasoup objects if they exist
    if (sendTransport && !sendTransport.closed) sendTransport.close();
    if (recvTransport && !recvTransport.closed) recvTransport.close();
    producers.forEach(p => { if (!p.closed) p.close(); });
    consumers.forEach(c => { if (!c.closed) c.close(); });

    // Clear state variables
    device = null;
    sendTransport = null;
    recvTransport = null;
    producers.clear();
    consumers.clear();
    remoteProducers.clear();
    pendingRequests.forEach(p => clearTimeout(p.timeoutId)); // Clear timeouts
    pendingRequests.clear();
    nextRequestId = 1;

    // Clear local media
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    localStream = null;
    localVideo.srcObject = null;

    // Clear remote media UI
    remoteVideosContainer.innerHTML = '<h2>Remote Videos</h2>';

    // Reset UI controls
    btnJoin.disabled = true; // Disabled until WS connects again
    btnLeave.disabled = true;
    btnPublish.disabled = true;
    btnStopPublish.disabled = true;
    roomIdInput.disabled = false;
    peerIdInput.disabled = false;
    serverUrlInput.disabled = false;
    updateConnectionStatus('Disconnected');

    log('Client state reset complete.');
}

/** Updates the state of publish/stop buttons based on current producers. */
function updatePublishButtonState() {
    // Only enable buttons if transports are ready and connected
    const canPublish = sendTransport && sendTransport.connectionState === 'connected';
    const isPublishing = producers.size > 0;

    btnPublish.disabled = !canPublish || isPublishing;
    btnStopPublish.disabled = !isPublishing;
}

/** Updates the connection status indicator. */
function updateConnectionStatus(status) {
    connectionStatus.textContent = status;
    if (status === 'Connected' || status === 'Joined') {
        connectionStatus.className = 'status-connected';
    } else {
        connectionStatus.className = 'status-disconnected';
    }
}


// --- Initialize ---
document.addEventListener('DOMContentLoaded', () => {
    // Wait for DOM before setting up listeners and connecting
    btnJoin.addEventListener('click', () => {
        if (!isConnected) {
            connectWebSocket(); // Attempt connection first
             // Wait for open event before joining
             const joinOnOpen = () => joinRoom();
             ws.addEventListener('open', joinOnOpen, { once: true });
             // Handle case where connection fails before 'open' fires
             ws.addEventListener('close', () => ws.removeEventListener('open', joinOnOpen), {once: true});
             ws.addEventListener('error', () => ws.removeEventListener('open', joinOnOpen), {once: true});
        } else {
            joinRoom(); // Already connected
        }
    });
    btnLeave.addEventListener('click', leaveRoom);
    btnPublish.addEventListener('click', publishLocalMedia);
    btnStopPublish.addEventListener('click', () => stopPublishing());

    resetClientState(); // Set initial UI state
    connectWebSocket(); // Initiate connection attempt on load
});
```

---

**Setup and Running Instructions:**

1.  **Create Directory:** `mkdir mediasoup-server-docker && cd mediasoup-server-docker`
2.  **Save Files:** Create all the files listed above (`package.json`, `.env`, `config.js`, `errors.js`, `RedisManager.js`, `Peer.js`, `Room.js`, `server.js`, `Dockerfile`, `docker-compose.yml`) in the `mediasoup-server-docker` directory.
3.  **Create `public` Directory:** `mkdir public`
4.  **Save Client Files:** Create `public/index.html`, `public/style.css`, and `public/client.js` with the code provided above.
5.  **Edit `.env`:** Open `.env` and **set `MEDIASOUP_ANNOUNCED_IP`** to the correct IP address (e.g., `127.0.0.1` for local testing, your LAN IP, or your public server IP). Also, verify the RTC port range (`10000-10999` is the new default).
6.  **Install Host Dependencies (for cert generation):** `npm install`
7.  **Generate Certificates:** `npm run generate-certs`
8.  **Build and Run Docker:** `docker-compose up --build -d`
9.  **Access Client:** Open your browser to `https://localhost:3000` (or the appropriate IP based on your `.env` setting). Accept the security warning for the self-signed certificate.
10. **Test:** Use two browser tabs/windows, **give each a unique Peer ID**, use the same Room ID, join, and publish media.

This provides the complete, runnable project structure with all the discussed enhancements.