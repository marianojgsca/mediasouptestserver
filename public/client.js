// public/client.js
// Use import instead of relying on window global
import * as mediasoupClient from 'mediasoup-client';
// REMOVE the old line: const mediasoupClient = window.mediasoupClient;

/* eslint-disable no-unused-vars, no-inner-declarations */

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
    if (logOutput) {
        logOutput.textContent += `[${new Date().toLocaleTimeString()}] ${message}\n`;
        logOutput.scrollTop = logOutput.scrollHeight; // Auto-scroll
    }
}
function logError(...args) {
    console.error(...args);
    // Added check for error object
    const message = args.map(arg => (arg instanceof Error) ? `${arg.name || 'Error'}: ${arg.message}` : (typeof arg === 'object' ? JSON.stringify(arg) : arg)).join(' ');
    if (logOutput) {
        logOutput.textContent += `[${new Date().toLocaleTimeString()}] [ERROR] ${message}\n`;
        logOutput.scrollTop = logOutput.scrollHeight;
    }
}

// --- Set Default Server URL ---
if (serverUrlInput) {
    serverUrlInput.value = `wss://${window.location.host}`;
}
// --- Set Random Default Peer ID ---
if (peerIdInput) {
    peerIdInput.value = `peer_${Math.random().toString(36).substring(2, 8)}`;
}


// --- WebSocket and JSON-RPC ---

/** Establishes WebSocket connection. */
function connectWebSocket() {
    const serverUrl = serverUrlInput?.value?.trim();
    if (!serverUrl) {
        logError('Cannot connect: Server URL input not found or empty.');
        return;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        log('WebSocket already connecting or open.');
        return;
    }

    log(`Connecting to WebSocket server at ${serverUrl}...`);
    updateConnectionStatus('Connecting...');

    try {
        ws = new WebSocket(serverUrl);

        ws.onopen = () => {
            log('WebSocket connection established');
            isConnected = true;
            if (btnJoin) btnJoin.disabled = false;
            updateConnectionStatus('Connected');
        };

        ws.onmessage = (event) => handleWebSocketMessage(event.data);

        ws.onerror = (error) => {
            logError('WebSocket error:', error);
            alert(`WebSocket error. Check console and server URL.\nURL: ${serverUrl}\nIs the server running? Is the certificate trusted?`);
            resetClientState();
        };

        ws.onclose = (event) => {
            log(`WebSocket connection closed: Code ${event.code}, Reason: ${event.reason || 'N/A'}`);
            const wasConnectedBefore = isConnected; // Store state before reset
            resetClientState(); // Reset state first
            if (wasConnectedBefore) { // Show alert only if we were previously connected
                 alert('WebSocket connection closed.');
            }
        };
    } catch (err) {
         logError("Failed to create WebSocket:", err);
         alert(`Failed to initiate WebSocket connection: ${err.message}`);
         resetClientState();
    }
}

/** Sends a JSON-RPC request and returns a Promise. */
function sendRpcRequest(method, params) {
    return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            // Use a simple error object for client-side checks
            return reject(new Error('WebSocket is not connected'));
        }
        const requestId = nextRequestId++;
        const request = { jsonrpc: '2.0', id: requestId, method, params: params || {} };
        log('Sending RPC Request:', JSON.stringify(request)); // Log stringified version
        ws.send(JSON.stringify(request));

        // Timeout for request
        const timeoutId = setTimeout(() => {
            if (pendingRequests.has(requestId)) {
                 const error = new Error(`Request timed out`);
                 logError(`Request ${requestId} (${method}) timed out`);
                 pendingRequests.get(requestId).reject(error);
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
        // Avoid logging excessively large messages if needed
        // log('Received message:', message);

        if (message.id && pendingRequests.has(message.id)) {
            // Handle RPC Response
            const pending = pendingRequests.get(message.id);
            clearTimeout(pending.timeoutId);
            if (message.error) {
                logError('RPC Error Response:', message.error);
                // Create an Error object from the server's error payload
                const error = new Error(message.error.message || 'RPC Error');
                error.code = message.error.code;
                error.data = message.error.data;
                pending.reject(error);
            } else {
                pending.resolve(message.result);
            }
            pendingRequests.delete(message.id);
        } else if (message.method) {
            // Handle RPC Notification
            handleRpcNotification(message.method, message.params);
        } else {
            log('Received unexpected message (not Response or Notification):', message);
        }
    } catch (error) {
        logError('Failed to parse WebSocket message:', error, data);
    }
}

/** Routes incoming notifications to specific handlers. */
function handleRpcNotification(method, params) {
    log(`Received notification: ${method}`); // Keep logging simple
    try {
        switch (method) {
            case 'newProducer': handleNewProducer(params); break;
            case 'producerClosed': handleProducerClosed(params); break;
            case 'peerJoined': log(`Peer ${params?.peerId} joined`); break;
            case 'peerClosed': log(`Peer ${params?.peerId} left`); break;
            case 'consumerClosed': handleConsumerClosed(params?.consumerId, params?.reason); break;
            case 'consumerPaused': handleConsumerPaused(params?.consumerId); break;
            case 'consumerResumed': handleConsumerResumed(params?.consumerId); break;
            case 'serverShutdown': handleServerShutdown(params?.reason); break;
            default: log(`Unhandled notification method: ${method}`);
        }
    } catch(error){
        logError(`Error handling notification ${method}:`, error);
    }
}

// --- Mediasoup Logic ---

/** Joins the room after WebSocket connection. */
async function joinRoom() {
    const roomId = roomIdInput?.value?.trim();
    const peerId = peerIdInput?.value?.trim();
    if (!roomId || !peerId) { alert('Please enter Room ID and Peer ID'); return; }

    if (!device) { device = new mediasoupClient.Device(); }

    if (btnJoin) btnJoin.disabled = true;
    log(`Joining room ${roomId} as peer ${peerId}...`);
    updateConnectionStatus('Joining...');

    try {
        const { routerRtpCapabilities, peers: initialPeers, producers: initialProducers } = await sendRpcRequest('joinRoom', { roomId, peerId });
        log('Join successful, loading device...');

         if (!device.loaded) {
            await device.load({ routerRtpCapabilities });
            log('Mediasoup device loaded');
         }

        // Create Transports concurrently
        await Promise.all([
            createSendTransport(),
            createRecvTransport()
        ]);
        log('Transports created (or verified existing).');


        // Update UI
        if (btnLeave) btnLeave.disabled = false;
        if (btnPublish) btnPublish.disabled = false;
        if (btnStopPublish) btnStopPublish.disabled = true;
        if (roomIdInput) roomIdInput.disabled = true;
        if (peerIdInput) peerIdInput.disabled = true;
        if (serverUrlInput) serverUrlInput.disabled = true;
        updateConnectionStatus('Joined');

        // Subscribe to initial producers
        log(`Processing ${initialProducers?.length || 0} initial producers...`);
        if (initialProducers && Array.isArray(initialProducers)) {
             initialProducers.forEach(producerInfo => {
                 if(producerInfo?.id) {
                     log(`Adding initial producer: ${producerInfo.id} from peer ${producerInfo.peerId}`);
                     remoteProducers.set(producerInfo.id, producerInfo);
                     subscribeToProducer(producerInfo.id);
                 }
             });
        }
        log(`Initial peers in room: ${initialPeers?.join(', ') || 'None'}`);

    } catch (error) {
        logError('Failed to join room:', error);
        const errorMsg = error.message || (typeof error === 'string' ? error : `Code: ${error.code}`);
        alert(`Failed to join room: ${errorMsg}`);
        resetClientState();
    } finally {
         if (btnJoin) btnJoin.disabled = !isConnected; // Re-enable only if WS is still connected
    }
}

/** Creates the Mediasoup Send Transport. */
async function createSendTransport() {
    if (sendTransport && !sendTransport.closed) {
        log('Send transport already exists.');
        return; // Don't recreate if exists and not closed
    }
    log('Creating send transport...');
    try {
        const transportInfo = await sendRpcRequest('createWebRtcTransport', { direction: 'send' });
        if (!transportInfo || !device) throw new Error("Missing transport info or device");

        sendTransport = device.createSendTransport(transportInfo);
        log('Send transport created:', sendTransport.id);

        // Event Listeners
        sendTransport.on('connect', /* ... same connect handler ... */);
        sendTransport.on('produce', /* ... same produce handler ... */);
        sendTransport.on('connectionstatechange', /* ... same connection state handler ... */);

    } catch (error) {
         logError('Failed to create send transport:', error);
         throw error; // Re-throw to be caught by joinRoom
    }
}

/** Creates the Mediasoup Receive Transport. */
async function createRecvTransport() {
    if (recvTransport && !recvTransport.closed) {
        log('Receive transport already exists.');
        return;
    }
    log('Creating recv transport...');
     try {
        const transportInfo = await sendRpcRequest('createWebRtcTransport', { direction: 'recv' });
        if (!transportInfo || !device) throw new Error("Missing transport info or device");

        recvTransport = device.createRecvTransport(transportInfo);
        log('Recv transport created:', recvTransport.id);

        // Event Listeners
        recvTransport.on('connect', /* ... same connect handler ... */);
        recvTransport.on('connectionstatechange', /* ... same connection state handler ... */);

    } catch (error) {
        logError('Failed to create recv transport:', error);
        throw error; // Re-throw
    }
}

// --- Re-add the full event listener implementations ---
function setupSendTransportListeners() {
    if (!sendTransport) return;
    // Clear existing listeners before adding new ones (important if re-creating transport)
    sendTransport.removeAllListeners();

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
            callback({ id: producerId });
        } catch (error) { logError(`Server-side produce failed for kind ${kind}:`, error); errback(error); }
    });

    sendTransport.on('connectionstatechange', (state) => {
        log(`Send transport connection state: ${state}`);
        if (state === 'failed' || state === 'closed' || state === 'disconnected') {
            logError(`Send transport state changed to ${state}, cleaning up producers.`);
            if (producers.size > 0) {
                 stopPublishing(`Transport ${state}`);
            }
        }
    });
}

function setupRecvTransportListeners() {
    if (!recvTransport) return;
    recvTransport.removeAllListeners();

    recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        log('Recv transport "connect" event');
        sendRpcRequest('connectWebRtcTransport', { transportId: recvTransport.id, dtlsParameters })
            .then(() => {
                callback();
                log('Recv transport connected to server');
                remoteProducers.forEach(producerInfo => subscribeToProducer(producerInfo.id));
            })
            .catch(error => { logError('Recv transport connection failed:', error); errback(error); });
    });

    recvTransport.on('connectionstatechange', (state) => {
        log(`Recv transport connection state: ${state}`);
        if (state === 'failed' || state === 'closed' || state === 'disconnected') {
            logError(`Receive transport state changed to ${state}.`);
        }
    });
}

// Modify createTransport functions to call setupListeners
async function createSendTransport() {
    // ... (creation logic) ...
    sendTransport = device.createSendTransport(transportInfo);
    setupSendTransportListeners(); // Call setup after creation
    // ...
}
async function createRecvTransport() {
    // ... (creation logic) ...
    recvTransport = device.createRecvTransport(transportInfo);
    setupRecvTransportListeners(); // Call setup after creation
    // ...
}


/** Gets and publishes local camera and microphone tracks. */
async function publishLocalMedia() {
    if (!sendTransport || !device) { alert('Cannot publish: Send transport or device not ready.'); return; }
    if (sendTransport.connectionState !== 'connected') { alert('Cannot publish: Send transport not connected.'); return; }
    if (producers.size > 0) { log('Already publishing.'); return; }

    log('Requesting local media (cam/mic)...');
    if(btnPublish) btnPublish.disabled = true;

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: { width: { ideal: 640 }, height: { ideal: 360 } }
        });
        log('Got local media stream');
        if(localVideo) localVideo.srcObject = localStream;

        const audioTrack = localStream.getAudioTracks()[0];
        const videoTrack = localStream.getVideoTracks()[0];

        const createAndTrackProducer = async (kind, track, options = {}, appData = {}) => {
             if (!track || !sendTransport || sendTransport.closed) return;
             try {
                log(`Publishing ${kind}...`);
                const producer = await sendTransport.produce({ track, ...options, appData: { ...appData, mediaType: kind } });
                producers.set(kind, producer);
                log(`${kind} producer created: ${producer.id}`);

                producer.on('transportclose', () => {
                    log(`${kind} producer ${producer.id} transport closed`);
                    producers.delete(kind);
                    updatePublishButtonState();
                });
                producer.on('trackended', () => {
                    log(`${kind} track ${track.id} ended`);
                    stopPublishing(`${kind} track ended`);
                });
                 producer.observer.once('close', () => {
                     log(`${kind} producer ${producer.id} observer closed.`);
                     producers.delete(kind);
                     updatePublishButtonState();
                 });

            } catch (trackError) {
                 logError(`Failed to publish ${kind}:`, trackError);
                 producers.delete(kind);
                 throw trackError;
            }
        };

        await createAndTrackProducer('audio', audioTrack, { codecOptions: { opusStereo: true, opusDtx: true } });
        await createAndTrackProducer('video', videoTrack, {
             encodings: [ { maxBitrate: 100000, scaleResolutionDownBy: 4 }, { maxBitrate: 300000, scaleResolutionDownBy: 2 }, { maxBitrate: 1000000, scaleResolutionDownBy: 1 } ],
             codecOptions: { videoGoogleStartBitrate: 1000 }
         });

        updatePublishButtonState();

    } catch (error) {
        logError('Failed to get or publish media:', error);
        alert(`Error publishing media: ${error.message}`);
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
            if(localVideo) localVideo.srcObject = null;
        }
        producers.forEach(p => { if (!p.closed) p.close(); });
        producers.clear();
        updatePublishButtonState();
    }
}

/** Stops publishing local media tracks. */
async function stopPublishing(reason = 'User action') {
    // ... (Stop publishing logic remains the same) ...
    log(`Stopping publishing... Reason: ${reason}`);
    if (producers.size === 0) {
        log('Not currently publishing.');
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
            if(localVideo) localVideo.srcObject = null;
        }
        updatePublishButtonState();
        return;
    }

    const closePromises = [];
    producers.forEach((producer, kind) => {
        if (!producer.closed) {
            log(`Closing ${kind} producer ${producer.id}`);
            closePromises.push(producer.close());
        }
    });

    await Promise.allSettled(closePromises);
    producers.clear();

    if (localStream) {
        log('Stopping local stream tracks');
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
        if(localVideo) localVideo.srcObject = null;
    }

    log('Publishing stopped.');
    updatePublishButtonState();
}


/** Handles notification that a new producer is available. */
function handleNewProducer(producerInfo) {
    // ... (Handling new producer logic remains the same) ...
     log('Handling new producer notification:', producerInfo);
    if (!producerInfo || !producerInfo.producerId || !producerInfo.peerId) {
        logError("Invalid newProducer notification received:", producerInfo);
        return;
    }
    remoteProducers.set(producerInfo.producerId, producerInfo); // Use producerId as key

    if (recvTransport && recvTransport.connectionState === 'connected') {
        subscribeToProducer(producerInfo.producerId);
    } else {
         log('Receive transport not ready, subscription deferred.');
    }
}

/** Initiates consumption of a remote producer. */
async function subscribeToProducer(producerId) {
    // ... (Subscription logic remains the same) ...
      if (!recvTransport || !device || !device.loaded || !remoteProducers.has(producerId)) {
        log(`Cannot subscribe: Prerequisite missing for producer ${producerId}.`);
        return;
    }
     let alreadyConsuming = false;
     consumers.forEach(c => { if (c.producerId === producerId) alreadyConsuming = true; });
     if (alreadyConsuming) {
         log(`Already consuming producer ${producerId}`);
         return;
     }

    const producerInfo = remoteProducers.get(producerId);
    log(`Subscribing to producer ${producerId} from peer ${producerInfo.peerId}...`);

    try {
        const { rtpCapabilities } = device;
        const consumeData = await sendRpcRequest('consume', { /* ... */ });

        if (!consumeData || !consumeData.id) throw new Error('Server did not return valid consumer parameters');
        const { id: consumerId, kind, rtpParameters, appData } = consumeData;

        const consumer = await recvTransport.consume({ /* ... */ });

        consumers.set(consumerId, consumer); // Key by consumerId

        // Event Listeners
        consumer.observer.once('close', () => { /* ... */ });
        consumer.on('transportclose', () => { /* ... */ });

        renderRemoteTrack(producerInfo.peerId, consumerId, consumer.track);

        await sendRpcRequest('consumerResume', { consumerId: consumer.id });
        log(`Resumed consumer ${consumer.id} on server`);

    } catch (error) { /* ... error handling ... */ }
}

/** Renders a remote media track in the UI. */
function renderRemoteTrack(peerId, consumerId, track) {
    // ... (Rendering logic remains the same) ...
    const peerContainerId = `peer-container-${peerId}`;
    let peerContainer = document.getElementById(peerContainerId);
    if (!peerContainer) { /* create peer container */ }

    const elementId = `remote-${consumerId}`;
    let mediaElement = document.getElementById(elementId);
    if (mediaElement) { /* remove existing */ }

    if (track.kind === 'video') { /* create video element */ }
    else { /* create audio element */ }
    mediaElement.id = elementId;
    mediaElement.srcObject = new MediaStream([track]);
    peerContainer.appendChild(mediaElement);

    if (track.kind === 'video') mediaElement.play().catch(e => logError(`Video play failed:`, e));
}

/** Handles notification that a remote producer was closed. */
function handleProducerClosed(params) {
    // ... (Producer closed logic remains the same) ...
     if (!params || !params.producerId) return;
    const { producerId } = params;
    log(`Handling producer closed event for producer ${producerId}`);
    remoteProducers.delete(producerId);

    consumers.forEach((consumer, consumerId) => {
        if (consumer.producerId === producerId) {
            log(`Closing consumer ${consumerId} because producer ${producerId} closed.`);
            removeConsumer(consumerId);
        }
    });
}

/** Handles notification that one of our consumers was closed by the server. */
function handleConsumerClosed(consumerId, reason) {
    // ... (Consumer closed logic remains the same) ...
     if (!consumerId) return;
     log(`Server indicated consumer ${consumerId} closed. Reason: ${reason || 'N/A'}`);
     removeConsumer(consumerId);
}

/** Handles notification that a consumer was paused by the server. */
function handleConsumerPaused(consumerId){
    // ... (Consumer paused logic remains the same) ...
     if (!consumerId) return;
    log(`Consumer ${consumerId} paused by server.`);
    const consumer = consumers.get(consumerId);
    if (consumer) {
        const mediaElement = document.getElementById(`remote-${consumerId}`);
        mediaElement?.classList.add('paused');
    }
}

/** Handles notification that a consumer was resumed by the server. */
function handleConsumerResumed(consumerId){
    // ... (Consumer resumed logic remains the same) ...
      if (!consumerId) return;
     log(`Consumer ${consumerId} resumed by server.`);
     const consumer = consumers.get(consumerId);
     if (consumer) {
        const mediaElement = document.getElementById(`remote-${consumerId}`);
        mediaElement?.classList.remove('paused');
     }
}

/** Handles server shutdown notification */
function handleServerShutdown(reason = 'Server initiated shutdown'){
    // ... (Server shutdown logic remains the same) ...
    logError(`SERVER SHUTDOWN notification received: ${reason}`);
    alert(`Server is shutting down: ${reason}\nConnection will be closed.`);
}


/** Removes a consumer and its associated UI element. */
function removeConsumer(consumerId) {
    // ... (Remove consumer logic remains the same) ...
    const consumer = consumers.get(consumerId);
    if (!consumer) return;
    log(`Removing consumer ${consumer.id}`);
    if (!consumer.closed) consumer.close();
    consumers.delete(consumerId);
    removeMediaElement(consumerId);
}

/** Removes the video/audio element associated with a consumer ID. */
function removeMediaElement(consumerId) {
    // ... (Remove media element logic remains the same) ...
    const mediaElement = document.getElementById(`remote-${consumerId}`);
    if (mediaElement) {
        mediaElement.srcObject = null;
        const peerContainer = mediaElement.closest('.remote-video-container');
        try { mediaElement.parentNode.removeChild(mediaElement); } catch (e) { /* ignore */ }
        if (peerContainer && peerContainer.querySelectorAll('video, audio').length === 0) {
             try { peerContainer.parentNode.removeChild(peerContainer); } catch (e) { /* ignore */ }
        }
    }
}


/** Leaves the room and cleans up resources. */
function leaveRoom() {
    // ... (Leave room logic remains the same) ...
    log('Leaving room...');
    if (btnLeave) btnLeave.disabled = true;

    try {
        stopPublishing('Leaving room');
        if (sendTransport && !sendTransport.closed) sendTransport.close();
        if (recvTransport && !recvTransport.closed) recvTransport.close();
        if (ws && ws.readyState === WebSocket.OPEN) {
             sendRpcRequest('leaveRoom', {}).catch(e => logError("Error sending leaveRoom request:", e));
        }
        log('Leave room initiated. Waiting for server/WS close to reset.');
    } catch (error) {
         logError("Error during leaveRoom:", error);
         resetClientState(); // Force reset on error
    } finally {
        updatePublishButtonState();
    }
}

/** Resets the entire client state and UI. */
function resetClientState() {
    // ... (Reset client state logic remains the same) ...
    log('Resetting client state...');
    const wasConnectedBefore = isConnected;
    isConnected = false;

    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'Client resetting state');
    ws = null;

    try { sendTransport?.close(); } catch (e) { /* ignore */ }
    try { recvTransport?.close(); } catch (e) { /* ignore */ }
    producers.forEach(p => { try { p.close(); } catch (e) { /* ignore */ } });
    consumers.forEach(c => { try { c.close(); } catch (e) { /* ignore */ } });

    device = null; sendTransport = null; recvTransport = null;
    producers.clear(); consumers.clear(); remoteProducers.clear();
    pendingRequests.forEach(p => clearTimeout(p.timeoutId));
    pendingRequests.clear(); nextRequestId = 1;

    if (localStream) localStream.getTracks().forEach(track => track.stop());
    localStream = null; if(localVideo) localVideo.srcObject = null;
    if (remoteVideosContainer) remoteVideosContainer.innerHTML = '<h2>Remote Videos</h2>';

    if (btnJoin) btnJoin.disabled = false; // Enable after reset
    if (btnLeave) btnLeave.disabled = true;
    if (btnPublish) btnPublish.disabled = true;
    if (btnStopPublish) btnStopPublish.disabled = true;
    if (roomIdInput) roomIdInput.disabled = false;
    if (peerIdInput) peerIdInput.disabled = false;
    if (serverUrlInput) serverUrlInput.disabled = false;
    updateConnectionStatus('Disconnected');

    log('Client state reset complete.');
}

/** Updates the state of publish/stop buttons. */
function updatePublishButtonState() {
    // ... (Update publish button logic remains the same) ...
     const canPublish = sendTransport && sendTransport.connectionState === 'connected';
    const isPublishing = producers.size > 0;
    if (btnPublish) btnPublish.disabled = !canPublish || isPublishing;
    if (btnStopPublish) btnStopPublish.disabled = !isPublishing;
}

/** Updates the connection status indicator. */
function updateConnectionStatus(status) {
    // ... (Update connection status logic remains the same) ...
    if (connectionStatus) {
        connectionStatus.textContent = status;
        connectionStatus.className = (status === 'Connected' || status === 'Joined' || status === 'Joining...') ? 'status-connected' : 'status-disconnected';
    }
}


// --- Initialize ---
document.addEventListener('DOMContentLoaded', () => {
    // Make sure mandatory elements exist
    if (!serverUrlInput || !roomIdInput || !peerIdInput || !btnJoin || !btnLeave || !btnPublish || !btnStopPublish || !localVideo || !remoteVideosContainer || !logOutput || !connectionStatus) {
        console.error("One or more required DOM elements are missing!");
        alert("Error: UI elements missing, cannot initialize client properly.");
        return;
    }

    // Setup Button Listeners
    btnJoin.addEventListener('click', () => {
        if (!isConnected) {
            connectWebSocket();
             if (ws) {
                 const joinOnOpen = () => joinRoom();
                 const cleanupListeners = () => { /* remove listeners */ }; // Define cleanup
                 ws.addEventListener('open', joinOnOpen, { once: true });
                 ws.addEventListener('close', cleanupListeners, { once: true });
                 ws.addEventListener('error', cleanupListeners, { once: true });
             }
        } else {
            joinRoom();
        }
    });
    btnLeave.addEventListener('click', leaveRoom);
    btnPublish.addEventListener('click', publishLocalMedia);
    btnStopPublish.addEventListener('click', () => stopPublishing());

    resetClientState(); // Set initial UI state
    connectWebSocket(); // Initiate connection attempt on load
});

// Add basic error handling for promises outside async functions if needed
window.addEventListener('unhandledrejection', function(event) {
  logError('Unhandled Promise Rejection:', event.reason);
});