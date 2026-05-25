/**
 * Virtual Cinema — Frontend Application
 * WebRTC P2P (video/audio/screen/file stream) + Socket.io signaling + Chat
 */

'use strict';

// ─── STUN Servers (free, Google + Cloudflare) ────────────────────────────────
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};

// ─── Quality Presets ─────────────────────────────────────────────────────────
const QUALITY_PRESETS = {
  1080: { width: 1920, height: 1080, frameRate: 30 },
  720:  { width: 1280, height: 720,  frameRate: 30 },
  480:  { width: 854,  height: 480,  frameRate: 24 },
  360:  { width: 640,  height: 360,  frameRate: 24 },
};

// ─── App State ───────────────────────────────────────────────────────────────
const state = {
  userId: null,
  userName: null,
  peerId: null,
  peerName: 'Partner',

  socket: null,
  pc: null,            // RTCPeerConnection
  localStream: null,   // Camera + mic
  screenStream: null,  // Screen share / video file stream
  isPolite: false,     // WebRTC "perfect negotiation" role

  camEnabled: true,
  micEnabled: true,
  selectedQuality: 720,

  isStreaming: false,
  peerIsStreaming: false,
};

// ─── DOM Refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const DOM = {
  // Login
  loginScreen:     $('login-screen'),
  cinemaScreen:    $('cinema-screen'),
  loginName:       $('login-name'),
  loginPassword:   $('login-password'),
  loginBtn:        $('login-btn'),
  loginError:      $('login-error'),

  // Topbar
  connectionBadge: $('connection-badge'),
  roomStatus:      $('room-status'),
  settingsBtn:     $('settings-btn'),
  settingsPanel:   $('settings-panel'),
  leaveBtn:        $('leave-btn'),

  // Stage
  stage:           $('stage'),
  stagePlaceholder:$('stage-placeholder'),
  remoteVideo:     $('remote-video'),
  localStreamPip:  $('local-stream-pip'),

  // Controls
  screenshareBtn:  $('screenshare-btn'),
  fileBtn:         $('file-btn'),
  fileInput:       $('file-input'),
  stopStreamBtn:   $('stop-stream-btn'),

  // Cameras
  localCam:        $('local-cam'),
  remoteCam:       $('remote-cam'),
  remoteCamLabel:  $('remote-cam-label'),
  remoteCamPlaceholder: $('remote-cam-placeholder'),
  toggleCam:       $('toggle-cam'),
  toggleMic:       $('toggle-mic'),

  // Chat
  chatMessages:    $('chat-messages'),
  chatInput:       $('chat-input'),
  chatSend:        $('chat-send'),
  onlineCount:     $('online-count'),

  // Toasts
  toastContainer:  $('toast-container'),
};

// ─── Utilities ────────────────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  DOM.toastContainer.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toast-out 0.3s ease forwards';
    el.addEventListener('animationend', () => el.remove());
  }, duration);
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function setConnectionBadge(status) {
  const badge = DOM.connectionBadge;
  badge.className = 'badge';
  if (status === 'online') {
    badge.classList.add('badge-online');
    badge.textContent = 'Connected';
  } else if (status === 'offline') {
    badge.classList.add('badge-offline');
    badge.textContent = 'Disconnected';
  } else {
    badge.classList.add('badge-connecting');
    badge.textContent = 'Connecting…';
  }
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
function appendMessage({ from, fromId, text, ts, system }) {
  const isOwn = fromId === state.userId;
  const div = document.createElement('div');
  div.className = `chat-msg${isOwn ? ' own' : ''}${system ? ' system' : ''}`;

  if (system) {
    div.innerHTML = `<div class="msg-bubble">${escapeHtml(text)}</div>`;
  } else {
    div.innerHTML = `
      <div class="msg-meta">
        <span class="msg-name">${escapeHtml(from)}</span>
        <span>${formatTime(ts)}</span>
      </div>
      <div class="msg-bubble">${escapeHtml(text)}</div>`;
  }

  DOM.chatMessages.appendChild(div);
  DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendChat() {
  const text = DOM.chatInput.value.trim();
  if (!text) return;
  state.socket.emit('chat:message', { text });
  DOM.chatInput.value = '';
}

// ─── Media: Local Camera ──────────────────────────────────────────────────────
async function startLocalCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 320 }, height: { ideal: 180 }, frameRate: { ideal: 24 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    state.localStream = stream;
    DOM.localCam.srcObject = stream;

    // Add tracks to peer connection if already connected
    if (state.pc) {
      stream.getTracks().forEach(track => {
        state.pc.addTrack(track, stream);
      });
    }

    toast('Camera ready', 'success', 2000);
  } catch (err) {
    console.warn('[CAM] Permission denied or no camera:', err.message);
    toast('Camera/mic unavailable — audio-only mode', 'info', 4000);
    // Try audio only
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.localStream = audioStream;
      if (state.pc) {
        audioStream.getTracks().forEach(track => state.pc.addTrack(track, audioStream));
      }
    } catch {
      toast('No microphone access', 'error');
    }
  }
}

// ─── Toggle Camera / Mic ──────────────────────────────────────────────────────
function toggleCam() {
  if (!state.localStream) return;
  const videoTrack = state.localStream.getVideoTracks()[0];
  if (!videoTrack) return;
  state.camEnabled = !state.camEnabled;
  videoTrack.enabled = state.camEnabled;
  DOM.toggleCam.classList.toggle('muted', !state.camEnabled);
  DOM.toggleCam.textContent = state.camEnabled ? '📷' : '🚫';
}

function toggleMic() {
  if (!state.localStream) return;
  const audioTrack = state.localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  state.micEnabled = !state.micEnabled;
  audioTrack.enabled = state.micEnabled;
  DOM.toggleMic.classList.toggle('muted', !state.micEnabled);
  DOM.toggleMic.textContent = state.micEnabled ? '🎤' : '🔇';
}

// ─── WebRTC Peer Connection ───────────────────────────────────────────────────
function createPeerConnection() {
  if (state.pc) {
    state.pc.close();
  }

  const pc = new RTCPeerConnection(ICE_SERVERS);
  state.pc = pc;

  // Add local camera tracks
  if (state.localStream) {
    state.localStream.getTracks().forEach(track => {
      pc.addTrack(track, state.localStream);
    });
  }

  // ICE candidates
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && state.peerId) {
      state.socket.emit('signal:ice', { to: state.peerId, candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log('[ICE]', pc.iceConnectionState);
    if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
      toast('Connection issue — attempting recovery…', 'error');
      if (pc.iceConnectionState === 'failed') {
        pc.restartIce();
      }
    }
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      setConnectionBadge('online');
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('[PC state]', pc.connectionState);
    if (pc.connectionState === 'failed') {
      toast('WebRTC connection failed. Try refreshing.', 'error', 6000);
    }
  };

  // Remote tracks
  pc.ontrack = ({ track, streams }) => {
    console.log('[TRACK received]', track.kind);

    if (track.kind === 'video') {
      // Heuristic: if peer is streaming to stage, show in stage video
      // Otherwise show in camera panel
      if (state.peerIsStreaming) {
        DOM.remoteVideo.srcObject = streams[0];
        showStageVideo();
      } else {
        // First video is camera
        if (!DOM.remoteCam.srcObject) {
          DOM.remoteCam.srcObject = streams[0];
          DOM.remoteCamPlaceholder.classList.add('hidden');
        } else {
          // Second video track = stage stream
          DOM.remoteVideo.srcObject = streams[0];
          showStageVideo();
        }
      }
    }

    if (track.kind === 'audio') {
      // Audio always goes to remote cam element (for playback)
      if (!DOM.remoteCam.srcObject) {
        DOM.remoteCam.srcObject = new MediaStream([track]);
      }
    }

    track.onunmute = () => console.log('[TRACK unmuted]', track.kind);
    track.onended  = () => console.log('[TRACK ended]', track.kind);
  };

  return pc;
}

// ─── Perfect Negotiation ─────────────────────────────────────────────────────
// Implements the "perfect negotiation" pattern to avoid glare conditions.
let makingOffer = false;
let ignoreOffer = false;

async function handleNegotiationNeeded() {
  try {
    makingOffer = true;
    await state.pc.setLocalDescription();
    state.socket.emit('signal:offer', {
      to: state.peerId,
      offer: state.pc.localDescription,
    });
  } catch (err) {
    console.error('[OFFER]', err);
  } finally {
    makingOffer = false;
  }
}

async function handleIncomingOffer({ from, offer }) {
  if (!state.pc || from !== state.peerId) return;

  const offerCollision = offer.type === 'offer' &&
    (makingOffer || state.pc.signalingState !== 'stable');

  ignoreOffer = !state.isPolite && offerCollision;
  if (ignoreOffer) {
    console.log('[SIGNAL] Ignoring offer due to glare (impolite peer)');
    return;
  }

  try {
    await state.pc.setRemoteDescription(offer);
    if (offer.type === 'offer') {
      await state.pc.setLocalDescription();
      state.socket.emit('signal:answer', {
        to: from,
        answer: state.pc.localDescription,
      });
    }
  } catch (err) {
    console.error('[OFFER handle]', err);
  }
}

async function handleIncomingAnswer({ from, answer }) {
  if (!state.pc || from !== state.peerId) return;
  if (ignoreOffer) return;
  try {
    await state.pc.setRemoteDescription(answer);
  } catch (err) {
    console.error('[ANSWER]', err);
  }
}

async function handleIncomingIce({ from, candidate }) {
  if (!state.pc || from !== state.peerId) return;
  try {
    await state.pc.addIceCandidate(candidate);
  } catch (err) {
    if (!ignoreOffer) console.error('[ICE]', err);
  }
}

// ─── Screen Share ─────────────────────────────────────────────────────────────
async function startScreenShare() {
  const preset = QUALITY_PRESETS[state.selectedQuality];
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: preset.frameRate },
        cursor: 'always',
      },
      audio: true,
    });

    await attachStreamToStage(stream, 'screen');

    // Stop when user clicks browser's built-in "stop sharing"
    stream.getVideoTracks()[0].onended = () => stopStream();

  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      toast('Screen share failed: ' + err.message, 'error');
    }
  }
}

// ─── Video File Stream ────────────────────────────────────────────────────────
async function startFileStream(file) {
  const url = URL.createObjectURL(file);
  const videoEl = document.createElement('video');
  videoEl.src = url;
  videoEl.autoplay = true;
  videoEl.controls = true; // Hidden, but used for capturing
  videoEl.muted = true;

  // We capture from the video element's MediaStream
  await new Promise(resolve => { videoEl.onloadedmetadata = resolve; });
  videoEl.play().catch(() => {});

  const stream = videoEl.captureStream ? videoEl.captureStream() : videoEl.mozCaptureStream();
  if (!stream) {
    toast('captureStream not supported in this browser', 'error');
    return;
  }

  await attachStreamToStage(stream, 'file');
  toast(`Streaming: ${file.name}`, 'success');

  // Store ref for cleanup
  state._fileVideoEl = videoEl;
  state._fileUrl = url;
}

// ─── Attach Stream to Stage + Peer ───────────────────────────────────────────
async function attachStreamToStage(stream, type) {
  // Store ref
  state.screenStream = stream;
  state.isStreaming = true;

  // Local PIP preview
  DOM.localStreamPip.srcObject = stream;
  DOM.localStreamPip.classList.remove('hidden');

  // UI
  DOM.stopStreamBtn.classList.remove('hidden');
  DOM.screenshareBtn.classList.add('hidden');
  DOM.fileBtn.classList.add('hidden');
  DOM.screenshareBtn.classList.add('active');

  // Notify peer
  state.socket.emit('stream:start', { type });

  // Add stream tracks to peer connection
  if (state.pc && state.peerId) {
    const senders = state.pc.getSenders();
    const videoSender = senders.find(s => s.track?.kind === 'video' && s.track !== state.localStream?.getVideoTracks()[0]);

    stream.getTracks().forEach(track => {
      const existingSender = senders.find(s => s.track?.kind === track.kind);
      if (existingSender && track.kind === 'video' && existingSender.track === state.localStream?.getVideoTracks()[0]) {
        // Replace camera track with stream track
        existingSender.replaceTrack(track).catch(console.error);
      } else if (!existingSender) {
        state.pc.addTrack(track, stream);
      }
    });
  }
}

// ─── Stop Stream ──────────────────────────────────────────────────────────────
function stopStream() {
  if (state.screenStream) {
    state.screenStream.getTracks().forEach(t => t.stop());
    state.screenStream = null;
  }

  if (state._fileVideoEl) {
    state._fileVideoEl.pause();
    state._fileVideoEl.src = '';
    state._fileVideoEl = null;
  }

  if (state._fileUrl) {
    URL.revokeObjectURL(state._fileUrl);
    state._fileUrl = null;
  }

  state.isStreaming = false;
  DOM.localStreamPip.srcObject = null;
  DOM.localStreamPip.classList.add('hidden');
  DOM.stopStreamBtn.classList.add('hidden');
  DOM.screenshareBtn.classList.remove('hidden', 'active');
  DOM.fileBtn.classList.remove('hidden');

  hideStageVideo();
  state.socket.emit('stream:stop');
  toast('Stream stopped', 'info', 2000);

  // Restore camera video track in peer connection
  if (state.pc && state.localStream) {
    const videoTrack = state.localStream.getVideoTracks()[0];
    if (videoTrack) {
      const sender = state.pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) sender.replaceTrack(videoTrack).catch(console.error);
    }
  }
}

function showStageVideo() {
  DOM.stagePlaceholder.classList.add('hidden');
  DOM.remoteVideo.classList.remove('hidden');
}

function hideStageVideo() {
  DOM.remoteVideo.classList.add('hidden');
  DOM.remoteVideo.srcObject = null;
  DOM.stagePlaceholder.classList.remove('hidden');
}

// ─── Quality Settings ─────────────────────────────────────────────────────────
function initQualityButtons() {
  document.querySelectorAll('.quality-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.selectedQuality = parseInt(btn.dataset.res);
      toast(`Quality set to ${btn.dataset.res}p`, 'info', 2000);
    });
  });
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
function initSocket() {
  const socket = io({ reconnectionDelay: 2000, reconnectionDelayMax: 10000 });
  state.socket = socket;

  socket.on('connect', () => {
    console.log('[SOCKET] Connected:', socket.id);
    setConnectionBadge('connecting');
  });

  socket.on('disconnect', reason => {
    console.log('[SOCKET] Disconnected:', reason);
    setConnectionBadge('offline');
    toast('Disconnected from server. Reconnecting…', 'error');
  });

  socket.on('reconnect', () => {
    toast('Reconnected!', 'success');
    // Re-authenticate
    socket.emit('auth', { password: state._password, name: state.userName });
  });

  // ── Auth ──────────────────────────────────────────────────────────────────
  socket.on('auth:ok', ({ userId, userName, history, peers }) => {
    state.userId = userId;
    state.userName = userName;
    setConnectionBadge('online');

    // Show cinema
    DOM.loginScreen.classList.remove('active');
    DOM.cinemaScreen.classList.add('active');

    // Load chat history
    history.forEach(msg => appendMessage(msg));

    // If peer already in room, initiate call
    if (peers.length > 0) {
      const peer = peers[0];
      state.peerId = peer.id;
      state.peerName = peer.name;
      state.isPolite = false; // We're joining after them → we're "impolite"
      DOM.remoteCamLabel.textContent = peer.name;
      DOM.roomStatus.textContent = `Watching with ${peer.name}`;
      updateOnlineCount(2);
      appendMessage({ system: true, text: `${peer.name} is already in the room.`, ts: Date.now() });

      // Start call
      initCall();
    }
  });

  socket.on('auth:fail', ({ message }) => {
    DOM.loginError.textContent = message;
    DOM.loginError.classList.remove('hidden');
    DOM.loginBtn.disabled = false;
    DOM.loginBtn.textContent = 'Enter Room';
  });

  // ── Peer Events ───────────────────────────────────────────────────────────
  socket.on('peer:joined', ({ id, name }) => {
    state.peerId = id;
    state.peerName = name;
    state.isPolite = true; // They joined after us → we're "polite"
    DOM.remoteCamLabel.textContent = name;
    DOM.roomStatus.textContent = `Watching with ${name}`;
    updateOnlineCount(2);
    appendMessage({ system: true, text: `${name} joined the room.`, ts: Date.now() });
    toast(`${name} joined! 🎬`, 'success');

    // New joiner triggers the offer
    initCall();
  });

  socket.on('peer:left', ({ id, name }) => {
    if (id === state.peerId) {
      state.peerId = null;
      DOM.remoteCamLabel.textContent = 'Partner';
      DOM.remoteCamPlaceholder.classList.remove('hidden');
      DOM.remoteCam.srcObject = null;
      DOM.roomStatus.textContent = 'Waiting for partner…';
      updateOnlineCount(1);
      hideStageVideo();
      state.peerIsStreaming = false;
      appendMessage({ system: true, text: `${name} left the room.`, ts: Date.now() });
      toast(`${name} left`, 'info');
    }
  });

  // ── Chat ──────────────────────────────────────────────────────────────────
  socket.on('chat:message', msg => appendMessage(msg));

  // ── WebRTC Signaling ──────────────────────────────────────────────────────
  socket.on('signal:offer',  data => handleIncomingOffer(data));
  socket.on('signal:answer', data => handleIncomingAnswer(data));
  socket.on('signal:ice',    data => handleIncomingIce(data));

  // ── Stream Events ─────────────────────────────────────────────────────────
  socket.on('stream:start', ({ from, type }) => {
    if (from === state.peerId) {
      state.peerIsStreaming = true;
      toast(`${state.peerName} started streaming (${type})`, 'info');
    }
  });

  socket.on('stream:stop', ({ from }) => {
    if (from === state.peerId) {
      state.peerIsStreaming = false;
      hideStageVideo();
      toast(`${state.peerName} stopped streaming`, 'info', 2000);
    }
  });
}

// ─── Init Call ────────────────────────────────────────────────────────────────
function initCall() {
  const pc = createPeerConnection();

  // "Perfect negotiation" — polite peer defers
  pc.onnegotiationneeded = handleNegotiationNeeded;

  toast('Establishing video call…', 'info', 2500);
}

// ─── Online Count ─────────────────────────────────────────────────────────────
function updateOnlineCount(n) {
  DOM.onlineCount.textContent = `${n} online`;
}

// ─── Login Flow ───────────────────────────────────────────────────────────────
function initLogin() {
  async function doLogin() {
    const name = DOM.loginName.value.trim() || 'Guest';
    const password = DOM.loginPassword.value;

    if (!password) {
      DOM.loginError.textContent = 'Please enter the room password.';
      DOM.loginError.classList.remove('hidden');
      return;
    }

    DOM.loginBtn.disabled = true;
    DOM.loginBtn.textContent = 'Entering…';
    DOM.loginError.classList.add('hidden');

    state.userName = name;
    state._password = password;

    // Init socket first (if not already)
    if (!state.socket) initSocket();

    // Start camera while we wait
    startLocalCamera();

    state.socket.emit('auth', { password, name });
  }

  DOM.loginBtn.addEventListener('click', doLogin);

  DOM.loginPassword.addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });

  DOM.loginName.addEventListener('keydown', e => {
    if (e.key === 'Enter') DOM.loginPassword.focus();
  });
}

// ─── UI Event Listeners ───────────────────────────────────────────────────────
function initUIEvents() {
  // Settings toggle
  DOM.settingsBtn.addEventListener('click', e => {
    e.stopPropagation();
    DOM.settingsPanel.classList.toggle('hidden');
  });
  document.addEventListener('click', () => DOM.settingsPanel.classList.add('hidden'));
  DOM.settingsPanel.addEventListener('click', e => e.stopPropagation());

  // Leave room
  DOM.leaveBtn.addEventListener('click', () => {
    if (confirm('Leave the cinema room?')) {
      stopStream();
      if (state.pc) state.pc.close();
      if (state.socket) state.socket.disconnect();
      location.reload();
    }
  });

  // Screen share
  DOM.screenshareBtn.addEventListener('click', () => {
    if (!state.peerId) {
      toast('Wait for your partner to join first', 'info');
      return;
    }
    startScreenShare();
  });

  // File stream
  DOM.fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!state.peerId) {
      toast('Wait for your partner to join first', 'info');
      DOM.fileInput.value = '';
      return;
    }
    await startFileStream(file);
    DOM.fileInput.value = ''; // Reset so same file can be re-selected
  });

  // Stop stream
  DOM.stopStreamBtn.addEventListener('click', stopStream);

  // Camera / mic toggles
  DOM.toggleCam.addEventListener('click', toggleCam);
  DOM.toggleMic.addEventListener('click', toggleMic);

  // Chat
  DOM.chatSend.addEventListener('click', sendChat);
  DOM.chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  // Quality buttons
  initQualityButtons();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initLogin();
  initUIEvents();
});
