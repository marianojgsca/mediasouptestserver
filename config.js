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